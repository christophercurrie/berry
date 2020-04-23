export function generateModuleLoader(pnpFilename: string) {
  return `import {createRequire, builtinModules} from 'module';
import {URL, pathToFileURL, fileURLToPath} from 'url';
import {join, extname} from 'path';

let require = createRequire(import.meta.url);

const pnpapi = require('./${pnpFilename}');
pnpapi.setup();

/**
 * Node's fs module, patched by pnp
 *
 * @type {typeof import('fs')}
 */
const fs = require('fs');

/**
 * Read the given file, can read into zipfiles of the yarn cache
 *
 * @param {string} path
 * @returns {Promise<Buffer>}
 */
function readFile(path) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, (err, content) => err ? reject(err) : resolve(content));
  });
}

/**
 * Check whether the given string is a valid URL
 *
 * @param {string} str
 * @returns {boolean}
 */
function isValidURL(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the given identifier is a raw identifier, or absolute/relative
 *
 * @param {string} identifier
 * @returns {boolean} true if the identifier is raw, false if it's absolute or relative
 */
function isRawIdentifier(identifier) {
  return !identifier.startsWith('/') && !identifier.startsWith('./') && !identifier.startsWith('../');
}

/**
 * Resolve the given identifier to a URL
 *
 * This loader adds two special types of URL:
 *
 * Certain node builtins are replaced with patched versions (fs). For those identifiers this function
 * returns a URL with a custom \`yarn-builtin:\` protocol.
 *
 * Files that are resolved to be coming from the yarn cache get a \`?yarn-cache\` query parameter added
 * to the actual \`file:\` URL.
 *
 * @param {string} identifier
 * @param {object} context
 * @param {string} context.parentURL
 * @param {string[]} context.conditions
 * @param {typeof resolve} defaultResolve
 * @returns {Promise<{url: string}>}
 */
export async function resolve(identifier, context, defaultResolve) {
  if (identifier === 'fs' || identifier === 'fs/promises') {
    const url = new URL(\`yarn-builtin:///\${identifier}\`);
    url.searchParams.set('actual', defaultResolve(identifier, context, defaultResolve).url);

    return {
      url: url.href,
    };
  }

  // We only handle raw identifiers, so identifiers that are
  // - builtins (apart from fs handled above)
  // - URLs (probably only file URLs, but who knows)
  // - relative/absolute
  // are handled by the default resolve function instead
  //
  // For relative identifiers we make an additional pass: if the parent comes from
  // the yarn cache, we assume the new file will need to come from the yarn cache
  // as well.
  // This works out because a non-yarn cache file can be loaded using the fs we use
  // to read from the yarn cache.

  if (builtinModules.includes(identifier) || isValidURL(identifier)) {
    return defaultResolve(identifier, context, defaultResolve);
  }

  const {parentURL} = context;

  if (!isRawIdentifier(identifier)) {
    const result = await defaultResolve(identifier, context, defaultResolve);

    if (parentURL && (new URL(parentURL)).searchParams.has('yarn-cache')) {
      const url = new URL(result.url);
      url.searchParams.set('yarn-cache', '');
      result.url = url.href;
    }

    return result;
  }

  const parentPath = parentURL ? fileURLToPath(parentURL) : undefined;
  const unqualified = pnpapi.resolveToUnqualified(identifier, parentPath);
  const qualified = pnpapi.resolveUnqualified(unqualified);

  const url = pathToFileURL(qualified);
  url.searchParams.set('yarn-cache', '');

  return {
    url: url.href,
  };
}

/**
 * Return the format of the module defined by the given URL
 *
 * @param {string} urlString URL of the module
 * @param {object} context (currently empty)
 * @param {typeof getFormat} defaultGetFormat
 * @returns {Promise<{format: string}>}
 */
export async function getFormat(urlString, context, defaultGetFormat) {
  const url = new URL(urlString);

  if (url.protocol === 'yarn-builtin:') {
    return {format: 'dynamic'};
  }

  if (!url.searchParams.has('yarn-cache')) {
    return defaultGetFormat(url, context, defaultGetFormat);
  }

  const qualified = fileURLToPath(url);

  // We cannot return the commonjs format here, because we can't hook into how
  // the module loader loads commonjs modules. In other words, that will use the
  // actual builtin filesystem, which fails to load files from the yarn cache.
  switch (extname(qualified)) {
    case '.mjs': return {format: 'module'};
    case '.cjs': return {format: 'dynamic'};
    case '.json': return {format: 'dynamic'};
    case '.js': {
      const {packageLocation} = pnpapi.getPackageInformation(
        pnpapi.findPackageLocator(qualified)
      );

      const manifest = JSON.parse(await readFile(join(packageLocation, 'package.json')));
      const isModulePackage = manifest.type === 'module';

      return {format: isModulePackage ? 'module' : 'dynamic'};
    }
    default:
      throw new Error(\`Can't define format for file with extension \${extanme(qualified)}\`);
  }
}

/**
 * Read the source file defined by the given URL
 *
 * @param {string} urlString
 * @param {object} context
 * @param {string} context.format
 * @param {typeof getSource} defaultGetSource
 * @returns {Promise<{source: string|Buffer}>} response
 */
export async function getSource(urlString, context, defaultGetSource) {
  const url = new URL(urlString);

  if (!url.searchParams.has('yarn-cache')) {
    return defaultGetSource(url, context, defaultGetSource);
  }

  return {
    source: await readFile(fileURLToPath(url)),
  };
}

/**
 * Instantiate dynamic modules defined by this loader
 *
 * @param {string} urlString
 * @returns {Promise<{exports: string[], execute: Function}>}
 */
export async function dynamicInstantiate(urlString) {
  const url = new URL(urlString);

  if (url.protocol === 'yarn-builtin:') {
    const identifier = url.pathname.slice(1);
    const builtinModule = await import(url.searchParams.get('actual'));
    const keys = Object.getOwnPropertyNames(builtinModule);

    return {
      exports: keys,
      execute: exports => {
        const actualModule = require(identifier);

        for (const key of keys) {
          if (key === 'default') {
            exports[key].set(actualModule);
          } else if (typeof builtinModule[key] !== 'function') {
            exports[key].set(actualModule[key]);
          } else {
            const fn = function (...args) {
              return actualModule[key](...args);
            };

            Object.defineProperties(fn, {
              name: {
                configurable: true,
                value: builtinModule[key].name,
              },
              length: {
                configurable: true,
                value: builtinModule[key].length,
              },
            });

            exports[key].set(fn);
          }
        }
      }
    };
  }

  if (url.searchParams.has('yarn-cache')) {
    const path = fileURLToPath(url);

    return {
      exports: ['default'],
      execute: exports => {
        exports.default.set(require(path));
      },
    };
  }

  throw new Error(\`Unable to dynamically instantiate URL \${urlString}\`);
}
`;
}
