import {Project, structUtils}                                                from '@yarnpkg/core';
import {PortablePath}                                                        from '@yarnpkg/fslib';
import getPath                                                               from 'lodash/get';
import pl                                                                    from 'tau-prolog';
import vm                                                                    from 'vm';

import {and, termEquals, prependGoals, rule, term, DependencyType, variable} from './util';

// eslint-disable-next-line @typescript-eslint/camelcase
const {is_atom: isAtom, is_instantiated_list: isInstantiatedList, is_variable: isVariable} = pl.type;

const projects = new WeakMap<pl.type.Session, Project>();

function getProject(thread: pl.type.Thread): Project {
  const project = projects.get(thread.session);

  if (project == null)
    throw new Error(`Assertion failed: A project should have been registered for the active session`);

  return project;
}

const tauModule = new pl.type.Module(`constraints`, {
  [`dependency_type/1`]: [
    rule(term(`dependency_type`, [term(DependencyType.Dependencies)])),
    rule(term(`dependency_type`, [term(DependencyType.DevDependencies)])),
    rule(term(`dependency_type`, [term(DependencyType.PeerDependencies)])),
  ],

  [`workspace/1`]: (thread, point, atom) => {
    const [workspaceCwd] = atom.args;
    const project = getProject(thread);

    if (isAtom(workspaceCwd)) {
      if (project.tryWorkspaceByCwd(workspaceCwd.id as PortablePath))
        thread.success(point);

      return;
    }

    if (!isVariable(workspaceCwd)) {
      thread.throwError(pl.error.instantiation(atom.indicator));
      return;
    }

    prependGoals(thread, point, Array.from(
      project.workspaces.values(),
      workspace => {
        return termEquals(workspaceCwd, workspace.relativeCwd);
      }),
    );
  },

  [`workspace_ident/2`]: (thread, point, atom) => {
    const [workspaceCwd, workspaceIdent] = atom.args;
    const project = getProject(thread);

    if (isAtom(workspaceCwd)) {
      const workspace = project.tryWorkspaceByCwd(workspaceCwd.id as PortablePath);

      if (!isAtom(workspaceIdent) && !isVariable(workspaceIdent)) {
        thread.throwError(pl.error.instantiation(atom.indicator));
        return;
      }

      // Workspace not found => this predicate can never match
      if (workspace == null)
        return;

      prependGoals(thread, point, [
        termEquals(workspaceIdent, structUtils.stringifyIdent(workspace.locator)),
      ]);
    } else if (isVariable(workspaceCwd)) {
      if (isAtom(workspaceIdent)) {
        const workspaces = project.workspacesByIdent.get(structUtils.parseIdent(workspaceIdent.id).identHash);

        if (workspaces != null) {
          prependGoals(thread, point, workspaces.map(workspace =>
            termEquals(workspaceCwd, workspace.relativeCwd)
          ));
        }
      } else if (isVariable(workspaceIdent)) {
        prependGoals(thread, point, Array.from(project.workspaces, workspace => and(
          termEquals(workspaceCwd, workspace.relativeCwd),
          termEquals(workspaceIdent, structUtils.stringifyIdent(workspace.locator)),
        )));
      } else {
        thread.throwError(pl.error.instantiation(atom.indicator));
      }
    } else {
      thread.throwError(pl.error.instantiation(atom.indicator));
    }
  },

  [`workspace_version/2`]: [
    rule(
      term(`workspace_version`, [variable(`WorkspaceCwd`), variable(`WorkspaceVersion`)]),
      term(`workspace_field`, [variable(`WorkspaceCwd`), term(`version`), variable(`WorkspaceVersion`)]),
    ),
  ],

  [`workspace_field/3`]: (thread, point, atom) => {
    const [workspaceCwd, fieldName, fieldValue] = atom.args;

    if (!isAtom(workspaceCwd) || !isAtom(fieldName)) {
      thread.throwError(pl.error.instantiation(atom.indicator));
      return;
    }

    const project = getProject(thread);
    const workspace = project.tryWorkspaceByCwd(workspaceCwd.id as PortablePath);

    // Workspace not found => this predicate can never match
    // We might want to throw here? We can be pretty sure the user did
    // something wrong at this point
    if (workspace == null)
      return;

    const value = getPath(workspace.manifest.raw!, fieldName.id);

    // Field is not present => this predicate can never match
    if (typeof value === `undefined`)
      return;

    prependGoals(thread, point, [
      termEquals(fieldValue, String(value)),
    ]);
  },

  [`workspace_field_test/3`]: [
    rule(
      term(`workspace_field_test`, [variable(`WorkspaceCwd`), variable(`FieldName`), variable(`CheckCode`)]),
      term(`workspace_field_test`, [variable(`WorkspaceCwd`), variable(`FieldName`), variable(`CheckCode`), term(`[]`)]),
    ),
  ],

  [`workspace_field_test/4`]: (thread, point, atom) => {
    const [workspaceCwd, fieldName, checkCode, checkArgv] = atom.args;

    if (!isAtom(workspaceCwd) || !isAtom(fieldName) || !isAtom(checkCode) || !isInstantiatedList(checkArgv)) {
      thread.throwError(pl.error.instantiation(atom.indicator));
      return;
    }

    const project = getProject(thread);
    const workspace = project.tryWorkspaceByCwd(workspaceCwd.id as PortablePath);

    // Workspace not found => this predicate can never match
    // We might want to throw here? We can be pretty sure the user did
    // something wrong at this point
    if (workspace == null)
      return;

    const value = getPath(workspace.manifest.raw!, fieldName.id);

    // Field is not present => this predicate can never match
    if (typeof value === `undefined`)
      return;

    // Inject the variables into a sandbox
    const vars: {[key: string]: any} = {$$: value};
    for (const [index, value] of (checkArgv.toJavaScript() as string[]).entries())
      vars[`$${index}`] = value;

    const result = vm.runInNewContext(checkCode.id, vars);

    if (result) {
      thread.success(point);
    }
  },

  [`workspace_has_dependency/4`]: [
    rule(
      term(
        `workspace_has_dependency`,
        [
          variable(`WorkspaceCwd`),
          variable(`DependencyIdent`),
          variable(`DependencyRange`),
          variable(`DependencyType`),
        ]),
      and(
        term(`workspace`, [variable(`WorkspaceCwd`)]),
        term(`dependency_type`, [variable(`DependencyType`)]),
        term(
          `internal_workspace_has_dependency`,
          [
            variable(`WorkspaceCwd`),
            variable(`DependencyIdent`),
            variable(`DependencyRange`),
            variable(`DependencyType`),
          ]),
      ),
    ),
  ],

  [`internal_workspace_has_dependency/4`]: (thread, point, atom) => {
    const [workspaceCwd, dependencyIdent, dependencyRange, dependencyType] = atom.args;

    if (!isAtom(workspaceCwd) || !isAtom(dependencyType)) {
      // We shouldn't get here, because workspace_has_dependency/4 guarantees we get instantiated
      // values here.
      thread.throwError(pl.error.instantiation(atom.indicator));
      return;
    }

    const workspaceInfo = getProject(thread).getWorkspaceByCwd(workspaceCwd.id as PortablePath)!;
    const registeredDependencies = workspaceInfo.manifest[dependencyType.id as DependencyType];

    if (registeredDependencies == null)
      return;

    if (isAtom(dependencyIdent)) {
      const dependencyIdentHash = structUtils.parseIdent(dependencyIdent.id).identHash;
      const dependencyDescriptor = registeredDependencies.get(dependencyIdentHash);

      if (dependencyDescriptor) {
        prependGoals(thread, point, [
          termEquals(dependencyRange, dependencyDescriptor.range),
        ]);
      }

      return;
    }

    if (!isVariable(dependencyIdent)) {
      thread.throwError(pl.error.instantiation(atom.indicator));
      return;
    }

    prependGoals(thread, point, Array.from(registeredDependencies.values(), (dependencyDescriptor) => {
      return and(
        termEquals(dependencyIdent, structUtils.stringifyIdent(dependencyDescriptor)),
        termEquals(dependencyRange, dependencyDescriptor.range),
      );
    }));
  },
}, [
  `dependency_type/1`,
  `workspace/1`,
  `workspace_ident/2`,
  `workspace_version/2`,
  `workspace_field/3`,
  `workspace_field_test/3`,
  `workspace_field_test/4`,
  `workspace_has_dependency/4`,
]);

export function linkProjectToSession(session: pl.type.Session, project: Project) {
  projects.set(session, project);

  session.consult(`:- use_module(library(${tauModule.id})).`);
}
