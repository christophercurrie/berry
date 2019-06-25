import {Plugin, Hooks, Project, SettingsDefinition, SettingsType} from '@berry/core';
import {npath}                                                    from '@berry/fslib';
import micromatch                                                 from 'micromatch';

const portableShellSettings: {[name: string]: SettingsDefinition} = {
  portableShell: {
    description: `Settings for the portable-shell plugin`,
    type: SettingsType.SHAPE,
    properties: {
      onlyLocalCommands: {
        description: `Whether to allow only commands installed via package dependencies`,
        type: SettingsType.BOOLEAN,
        default: true,
      },
      envWhitelist: {
        description: `Whitelist of environment variables to allow`,
        type: SettingsType.STRING,
        default: null,
        isArray: true,
        nullable: true,
      },
    },
  },
};

async function setupScriptEnvironment(project: Project, env: {[key: string]: string}) {
  const configuration = project.configuration.get(`portableShell`);

  if (configuration.get(`onlyLocalCommands`)) {
    env.PATH = env.BERRY_BIN_FOLDER;
  }

  if (configuration.get(`envWhitelist`)) {
    const whitelist = new Set<string>([].concat(configuration.get(`envWhitelist`)));

    // always whitelist:
    // - the path to allow commands to work
    whitelist.add(`PATH`);
    // - the berry bin folder, because berry needs it
    whitelist.add(`BERRY_BIN_FOLDER`);
    // - the node options because we use it to insert pnp into any node commands
    whitelist.add(`NODE_OPTIONS`);

    const envKeys = Object.keys(env);
    const allowedDependencies = new Set(micromatch(envKeys, [...whitelist]));
    for (const key of envKeys) {
      if (!allowedDependencies.has(key)) {
        delete env[key];
      }
    }
  }
}

const plugin: Plugin = {
  configuration: portableShellSettings,
  hooks: {
    setupScriptEnvironment,
  } as Hooks,
};

// eslint-disable-next-line arca/no-default-export
export default plugin;
