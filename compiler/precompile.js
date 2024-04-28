import { Opcodes } from './wasmSpec.js';

import fs from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const TYPES = {
  number: 0x00,
  boolean: 0x01,
  string: 0x02,
  undefined: 0x03,
  object: 0x04,
  function: 0x05,
  symbol: 0x06,
  bigint: 0x07,

  // these are not "typeof" types but tracked internally
  _array: 0x10,
  _regexp: 0x11,
  _bytestring: 0x12
};

// import porfParse from './parse.js';
// import porfCodegen from './codeGen.js';

const argv = process.argv.slice();

const compile = async (file, [ _funcs, _globals ]) => {
  const source = fs.readFileSync(file, 'utf8');
  const first = source.slice(0, source.indexOf('\n'));

  let args = ['-bytestring', '-todo-time=compile'];
  if (file.endsWith('.ts')) args.push('-parse-types', '-opt-types');
  if (first.startsWith('// @porf')) {
    args = args.concat(first.slice('// @porf '.length).split(' '));
  }
  process.argv = argv.concat(args);

  // const porfParse = (await import(`./parse.js?_=${Date.now()}`)).default;
  // const porfCodegen = (await import(`./codeGen.js?_=${Date.now()}`)).default;

  // let { funcs, globals, data } = porfCodegen(porfParse(source, ['module']));

  const porfCompile = (await import(`./index.js?_=${Date.now()}`)).default;

  let { funcs, globals, data, exceptions } = porfCompile(source, ['module']);

  const allocated = new Set();

  const exports = funcs.filter(x => x.export);
  for (const x of exports) {
    if (x.data) {
      x.data = x.data.map(x => data[x]);
      for (const y in x.data) {
        x.data[y].offset -= x.data[0].offset;
      }
    }
    if (x.exceptions) x.exceptions = x.exceptions.map(x => {
      const obj = exceptions[x];
      if (obj) obj.exceptId = x;
      return obj;
    }).filter(x => x);

    const locals = Object.keys(x.locals).reduce((acc, y) => {
      acc[x.locals[y].idx] = { ...x.locals[y], name: y };
      return acc;
    }, {});

    for (let i = 0; i < x.wasm.length; i++) {
      const y = x.wasm[i];
      const n = x.wasm[i + 1];
      if (y[0] === Opcodes.call) {
        const f = funcs.find(x => x.index === y[1]);
        if (!f) continue;

        y[1] = f.name;
      }

      if (y[0] === Opcodes.const && (n[0] === Opcodes.local_set || n[0] === Opcodes.local_tee)) {
        const l = locals[n[1]];
        if (!l) continue;
        if (![TYPES.string, TYPES._array, TYPES._bytestring].includes(l.metadata?.type)) continue;
        if (!x.pages) continue;

        const pageName = [...x.pages.keys()].find(z => z.endsWith(l.name));
        if (!pageName || allocated.has(pageName)) continue;
        allocated.add(pageName);

        y.splice(0, 10, 'alloc', pageName, x.pages.get(pageName).type);
        // y.push(x.pages.get(pageName));
      }
    }
  }

  _funcs.push(...exports);
  _globals.push(...Object.values(globals));
};

const precompile = async () => {
  const dir = join(__dirname, 'builtins');

  let funcs = [], globals = [];
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.d.ts')) continue;
    await compile(join(dir, file), [ funcs, globals ]);
  }

  // ${x.pages && x.pages.size > 0 ? `    pages: ${JSON.stringify(Object.fromEntries(x.pages.entries()))},` : ''}
  // ${x.used && x.used.length > 0 ? `    used: ${JSON.stringify(x.used)},` : ''}

  return `// autogenerated by compiler/precompile.js
import { number } from './embedding.js';

export const BuiltinFuncs = function() {
${funcs.map(x => `  this.${x.name} = {
    wasm: (scope, { allocPage, builtin }) => ${JSON.stringify(x.wasm.filter(x => x.length && x[0] != null)).replace(/\["alloc","(.*?)","(.*?)"\]/g, (_, reason, type) => `...number(allocPage(scope, '${reason}', '${type}') * pageSize, ${valtypeBinary})`).replace(/\[16,"(.*?)"]/g, (_, name) => `[16, builtin('${name}')]`)},
    params: ${JSON.stringify(x.params)},
    typedParams: true,
    returns: ${JSON.stringify(x.returns)},
    ${x.returnType != null ? `returnType: ${JSON.stringify(x.returnType)}` : 'typedReturns: true'},
    locals: ${JSON.stringify(Object.values(x.locals).slice(x.params.length).map(x => x.type))},
    localNames: ${JSON.stringify(Object.keys(x.locals))},
${x.data && x.data.length > 0 ? `    data: ${JSON.stringify(x.data)},` : ''}
${x.exceptions && x.exceptions.length > 0 ? `    exceptions: ${JSON.stringify(x.exceptions)},` : ''}
  };`.replaceAll('\n\n', '\n').replaceAll('\n\n', '\n')).join('\n')}
};`;
};

const code = await precompile();
// console.log(code);

fs.writeFileSync(join(__dirname, 'generated_builtins.js'), code);