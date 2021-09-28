const Path = require('path');
const Fs = require('fs-extra');
const MagicString = require('magic-string');

const hasOwnProperty = Object.prototype.hasOwnProperty;

function nativePlugin(options) {

    let copyTo = options.copyTo || './';
    let destDir = options.destDir || './';
    let dlopen = options.dlopen || false;
    let nativePathMapper = options.map;
    let isSourceMapEnabled = options.sourceMap !== false && options.sourcemap !== false;
    
    let es6 = options.es6 || false;  // shouldn't get this from output options?
    
    if (typeof nativePathMapper !== 'function') {
        nativePathMapper = generateDefaultMapping;
    }

    const PREFIX = '\0natives:';

    let renamedMap = /**@type {Map<String, {name: String, copyTo: String}>}*/new Map();

    function rebaseModule(basename) {
        return (destDir + (/\\$|\/$/.test(destDir) ? '' : '/') + basename).replace(/\\/g, '/');
    }

    function findAvailableBasename(path) {
        let basename = Path.basename(path);

        let i = 1;
        while (Array.from(renamedMap.values()).filter(x => x.name === rebaseModule(basename)).length) {
            basename = Path.basename(path, Path.extname(path)) + '_' + (i++) + Path.extname(path);
        }

        return basename;
    }

    function generateDefaultMapping(path) {
        let basename = findAvailableBasename(path);

        return {
            name: rebaseModule(basename),
            copyTo: Path.join(copyTo, basename),
        };
    }

    function mapAndReturnPrefixedId(_import, warnFn) {
        let importee = _import[0], importer = _import[1];
        let resolvedFull = Path.resolve(importer ? Path.dirname(importer) : '', importee);

        let nativePath = null;
        if (/\.(node|dll)$/i.test(importee))
            nativePath = resolvedFull;
        else if (Fs.pathExistsSync(resolvedFull + '.node'))
            nativePath = resolvedFull + '.node';
        else if (Fs.pathExistsSync(resolvedFull + '.dll'))
            nativePath = resolvedFull + '.dll';

        if (nativePath) {
            let mapping = renamedMap.get(nativePath);

            if (!mapping) {
                mapping = nativePathMapper(nativePath);
                if (typeof mapping === 'string') {
                    mapping = generateDefaultMapping(mapping);
                }

                if (Fs.pathExistsSync(nativePath)) {
                    Fs.copyFileSync(nativePath, mapping.copyTo);
                } else {
                    warnFn(`${nativePath} does not exist`);
                }

                renamedMap.set(nativePath, mapping);
            }

            return PREFIX + mapping.name;
        }

        return null;
    }

    return {
        name: 'rollup-plugin-natives',

        buildStart(_options) {
            Fs.mkdirpSync(copyTo, { recursive: true });
        },

        resolveId(importee, importer) {
            if (importee.startsWith(PREFIX)) {
                return importee;
            }

            // Avoid trouble with other plugins like commonjs
            if (importer && importer[0] === '\0' && importer.indexOf(':') !== -1) importer = importer.slice(importer.indexOf(':') + 1);
            if (importee && importee[0] === '\0' && importee.indexOf(':') !== -1) importee = importee.slice(importee.indexOf(':') + 1);
            if (importee.endsWith('?commonjs-require'))
                importee = importee.slice(1, -'?commonjs-require'.length);

            return mapAndReturnPrefixedId([importee, importer], this.warn);
        },

        transform(code, id) {  // catch various forms of "require", convert to dynamic imports
            let magicString = new MagicString(code);

            const getModuleRoot = (() => {
                let moduleRoot = null;

                return () => {
                    if (moduleRoot === null) {
                        moduleRoot = Path.dirname(id);
                        let prev = null;
                        while (true) { // eslint-disable-line no-constant-condition
                            if (moduleRoot === '.')
                                moduleRoot = process.cwd();

                            if (Fs.pathExistsSync(Path.join(moduleRoot, 'package.json')) ||
                                Fs.pathExistsSync(Path.join(moduleRoot, 'node_modules')))
                                break;

                            if (prev === moduleRoot)
                                break;

                            // Try the parent dir next
                            prev = moduleRoot;
                            moduleRoot = Path.resolve(moduleRoot, '..');
                        }
                    }

                    return moduleRoot;
                };
            })();

            const replace = (code, magicString, pattern, fn) => {
                let result = false;
                let match;
        
                while ((match = pattern.exec(code))) {
                    let replacement = fn(match);
                    if (replacement !== null) {
                        let start = match.index;
                        let end = start + match[0].length;
                        magicString.overwrite(start, end, replacement);
            
                        result = true;
                    }
                }
        
                return result;
            };

            let bindingsRgx = /require\(['"]bindings['"]\)\(((['"]).+?\2)?\)/g;
            let hasNativeRequirements = replace(code, magicString, bindingsRgx, (match) => {
                let name = match[1];

                let nativeAlias = name ? new Function('return ' + name)() : 'bindings.node';
                if (!nativeAlias.endsWith('.node'))
                    nativeAlias += '.node';

                let partsMap = {
                    'compiled': process.env.NODE_BINDINGS_COMPILED_DIR || 'compiled',
                    'platform': options.target_platform || process.platform,
                    'arch': options.target_arch || process.arch,
                    'version': process.versions.node,
                    'bindings': nativeAlias,
                    'module_root': getModuleRoot(),
                };

                let possibilities = [
                    ['module_root', 'build', 'bindings'],
                    ['module_root', 'build', 'Debug', 'bindings'],
                    ['module_root', 'build', 'Release', 'bindings'],
                    ['module_root', 'compiled', 'version', 'platform', 'arch', 'bindings'],
                ];

                let possiblePaths = /**@type {String[]}*/possibilities.map(parts => {
                    parts = parts.map(part => {
                        if (hasOwnProperty.call(partsMap, part))
                            return partsMap[part];
                        return part;
                    });
                    return Path.join.apply(Path, parts);
                });

                let chosenPath = possiblePaths.find(x => Fs.pathExistsSync(x)) || possiblePaths[0];

                let prefixedId = mapAndReturnPrefixedId([chosenPath], this.warn);
                if (prefixedId) {
                    return "import(" + JSON.stringify(prefixedId) + ")";
                }

                return null;
            });
            
            let simpleRequireRgx = /require\(['"](.*?)['"]\)/g;
            hasNativeRequirements += replace(code, magicString, simpleRequireRgx, (match) => {
                let path = match[1];

                if (!path.endsWith('.node'))
                    path += '.node';

                path = Path.join(getModuleRoot(), path);

                if (Fs.pathExistsSync(path)) {
                    let prefixedId = mapAndReturnPrefixedId([path], this.warn);
                    if (prefixedId) {
                        return "import(" + JSON.stringify(prefixedId) + ")";
                    }
                }

                return null;
            });

            if (code.indexOf('node-pre-gyp') !== -1) {
                let varRgx = /(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\((['"])(@mapbox\/node-pre-gyp|node-pre-gyp)\3\);/;
                let binaryRgx = /\b(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+binary\.find\(path\.resolve\(path\.join\(__dirname,\s*((?:['"]).*\4)\)\)\);?\s*(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\(\2\)/g;

                let varMatch = code.match(varRgx);
                if (varMatch) {
                    binaryRgx = new RegExp(`\\b(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+${varMatch[2]}\\.find\\(path\\.resolve\\(path\\.join\\(__dirname,\\s*((?:['"]).*\\4)\\)\\)\\);?\\s*(var|let|const)\\s+([a-zA-Z0-9_]+)\\s+=\\s+require\\(\\2\\)`, 'g');
                }

                hasNativeRequirements += replace(code, magicString, binaryRgx, (match) => {
                    let preGyp = null;

                    let r1 = varMatch && varMatch[4][0] === '@' ? '@mapbox/node-pre-gyp' : 'node-pre-gyp';
                    let r2 = varMatch && varMatch[4][0] === '@' ? 'node-pre-gyp' : '@mapbox/node-pre-gyp';

                    try {
                        // noinspection NpmUsedModulesInstalled
                        preGyp = require(r1);
                    } catch (ex) {
                        try {
                            // noinspection NpmUsedModulesInstalled
                            preGyp = require(r2);
                        } catch (ex) {
                            return null;
                        }
                    }

                    let [, d1, v1, ref, d2, v2] = match;

                    let libPath = preGyp.find(Path.resolve(Path.join(Path.dirname(id), new Function('return ' + ref)())), options);

                    let prefixedId = mapAndReturnPrefixedId([libPath], this.warn);
                    if (prefixedId) {
                        return `${d1} ${v1} = ${JSON.stringify(renamedMap.get(libPath).name.replace(/\\/g, '/'))}; ${d2} ${v2} = import(${JSON.stringify(prefixedId)})`;
                    }

                    return null;
                });
            }

            if (hasNativeRequirements) {
                let result = { code: magicString.toString() };
                if (isSourceMapEnabled) {
                    result.map = magicString.generateMap({ hires: true });
                }

                return result;
            }

            return null;
        },


        resolveDynamicImport(id) {
            if (id.startsWith(PREFIX)) {
                return { id: id.substr(PREFIX.length), external: true };
            }

            if (renamedMap.has(id)) {
                return { id: renamedMap.get(id).name, external: true };
            }

            return null;
        },

        outputOptions(options) {
            if ((options.format ?? 'es') === 'es' && renamedMap.size) {
                options.intro = options.intro ?? [];
                options.intro.push(`import { createRequire } from 'module'; const require = createRequire(import.meta.url);`);

                return options;
            }

            return null;
        },

        renderDynamicImport() {
            return { left: 'require(', right: ')' };
        },
    };
}

module.exports = nativePlugin;
