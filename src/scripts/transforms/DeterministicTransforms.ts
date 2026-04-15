import { parse, type Node } from 'acorn';
import { ancestor, simple } from 'acorn-walk';
import { generate } from 'escodegen';

// ESTree node types (acorn produces ESTree-compliant ASTs)
type AnyNode = Node & Record<string, any>;

export interface TransformResult {
    code: string;
    transformsApplied: string[];
}

// Marker for nodes to be removed from parent body arrays
const REMOVED = Symbol('removed');

export class DeterministicTransforms {
    static run(code: string): TransformResult {
        const transformsApplied: string[] = [];

        let ast: AnyNode;
        try {
            ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) as AnyNode;
        } catch {
            try {
                ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as AnyNode;
            } catch {
                return { code, transformsApplied: [] };
            }
        }

        const passes = [
            { name: 'Resolve decoder calls', fn: resolveDecoderCalls },
            { name: 'Resolve string arrays', fn: resolveStringArrays },
            { name: 'Decode literals', fn: decodeLiterals },
            { name: 'Constant folding', fn: constantFolding },
            { name: 'Resolve static calls', fn: resolveStaticCalls },
            { name: 'Simplify sequences', fn: simplifySequences },
            { name: 'Unwrap eval/Function', fn: unwrapEval },
            { name: 'Remove dead code', fn: removeDeadCode },
        ];

        let anyChanged = true;
        let iterations = 0;
        while (anyChanged && iterations < 5) {
            anyChanged = false;
            iterations++;
            for (const pass of passes) {
                try {
                    if (pass.fn(ast)) {
                        if (!transformsApplied.includes(pass.name)) {
                            transformsApplied.push(pass.name);
                        }
                        anyChanged = true;
                    }
                } catch (e) {
                    console.warn(`Transform "${pass.name}" failed:`, e);
                }
            }
        }

        const output = generate(ast, { comment: true });
        return { code: output, transformsApplied };
    }
}

// ---------------------------------------------------------------------------
// Helpers: replace a node in-place by copying all properties from replacement
// ---------------------------------------------------------------------------

function replaceNode(target: AnyNode, replacement: AnyNode) {
    for (const key of Object.keys(target)) {
        if (key === 'start' || key === 'end') continue;
        delete target[key];
    }
    for (const key of Object.keys(replacement)) {
        target[key] = replacement[key];
    }
}

function markRemoved(node: AnyNode) {
    (node as any)[REMOVED] = true;
}

function sweepRemoved(ast: AnyNode) {
    simple(ast, {
        Program(node: AnyNode) {
            node.body = node.body.filter((n: any) => !n[REMOVED]);
        },
        BlockStatement(node: AnyNode) {
            node.body = node.body.filter((n: any) => !n[REMOVED]);
        },
        SwitchCase(node: AnyNode) {
            node.consequent = node.consequent.filter((n: any) => !n[REMOVED]);
        }
    });
}

function literal(value: string | number | boolean | null): AnyNode {
    if (typeof value === 'string') return { type: 'Literal', value, raw: JSON.stringify(value) } as any;
    if (typeof value === 'number') {
        // escodegen cannot handle negative numeric literals — wrap in UnaryExpression
        if (value < 0) {
            return {
                type: 'UnaryExpression',
                operator: '-',
                prefix: true,
                argument: { type: 'Literal', value: -value, raw: String(-value) }
            } as any;
        }
        return { type: 'Literal', value, raw: String(value) } as any;
    }
    if (typeof value === 'boolean') return { type: 'Literal', value, raw: String(value) } as any;
    return { type: 'Literal', value: null, raw: 'null' } as any;
}

function identifier(name: string): AnyNode {
    return { type: 'Identifier', name } as any;
}

// ---------------------------------------------------------------------------
// Layer 1-pre: Resolve function-wrapped string pools + decoder calls
// Handles obfuscator.io pattern: pool function returns string[], rotation IIFE
// shifts the array, decoder function indexes with an offset.
// ---------------------------------------------------------------------------

function resolveDecoderCalls(ast: AnyNode): boolean {
    let changed = false;

    // Step 1: Find function-wrapped string pools
    // Pattern: function foo() { const arr = ["s1", "s2", ...]; foo = function(){ return arr; }; return arr; }
    const pools = new Map<string, { strings: string[]; node: AnyNode }>();

    simple(ast, {
        FunctionDeclaration(node: AnyNode) {
            if (!node.id?.name) return;
            const result = extractStringPool(node);
            if (result) pools.set(node.id.name, { strings: result, node });
        }
    });

    if (pools.size === 0) return false;

    // Step 2: Find aliases for pool functions (var stringPool = _0x2d96)
    const poolAliases = new Map<string, string>(); // alias → real pool name

    simple(ast, {
        VariableDeclarator(node: AnyNode) {
            if (node.id?.type === 'Identifier' && node.init?.type === 'Identifier') {
                if (pools.has(node.init.name)) {
                    poolAliases.set(node.id.name, node.init.name);
                }
            }
        }
    });

    // Helper: resolve a name to a pool
    const resolvePool = (name: string): string | null => {
        if (pools.has(name)) return name;
        if (poolAliases.has(name)) return poolAliases.get(name)!;
        return null;
    };

    // Step 3: Find decoder functions
    // Pattern: function decode(x) { const arr = poolFn(); const idx = x - offset; return arr[idx]; }
    const decoders = new Map<string, { poolName: string; offset: number; node: AnyNode }>();

    simple(ast, {
        FunctionDeclaration(node: AnyNode) {
            if (!node.id?.name || pools.has(node.id.name)) return;
            const result = detectDecoderFunction(node, resolvePool);
            if (result) decoders.set(node.id.name, { ...result, node });
        }
    });

    // Also check variable-assigned functions
    simple(ast, {
        VariableDeclarator(node: AnyNode) {
            if (!node.id?.name) return;
            const fn = node.init;
            if (fn?.type === 'FunctionExpression' || fn?.type === 'ArrowFunctionExpression') {
                const result = detectDecoderFunction(fn, resolvePool);
                if (result) decoders.set(node.id.name, { ...result, node });
            }
        }
    });

    if (decoders.size === 0) return false;

    // Step 4: Find aliases for decoder functions (const D = decodeString)
    const decoderAliases = new Map<string, string>(); // alias → real decoder name

    simple(ast, {
        VariableDeclarator(node: AnyNode) {
            if (node.id?.type === 'Identifier' && node.init?.type === 'Identifier') {
                const target = node.init.name;
                if (decoders.has(target)) {
                    decoderAliases.set(node.id.name, target);
                } else if (decoderAliases.has(target)) {
                    decoderAliases.set(node.id.name, decoderAliases.get(target)!);
                }
            }
        }
    });

    // Build a set of all names that resolve to a decoder
    const allDecoderNames = new Set<string>([...decoders.keys(), ...decoderAliases.keys()]);
    const resolveDecoder = (name: string): { poolName: string; offset: number } | null => {
        if (decoders.has(name)) return decoders.get(name)!;
        const base = decoderAliases.get(name);
        if (base && decoders.has(base)) return decoders.get(base)!;
        return null;
    };

    // Step 5: Find rotation IIFE and brute-force the correct rotation
    const resolvedPools = new Map<string, string[]>();

    simple(ast, {
        ExpressionStatement(node: AnyNode) {
            const expr = node.expression;
            if (expr?.type !== 'CallExpression') return;
            const callee = expr.callee;
            if (callee?.type !== 'FunctionExpression' && callee?.type !== 'ArrowFunctionExpression') return;

            const args = expr.arguments as AnyNode[];
            if (args.length < 2) return;

            // Find pool reference arg and numeric target arg
            let poolName: string | null = null;
            let target: number | null = null;

            for (const arg of args) {
                if (arg.type === 'Identifier' && resolvePool(arg.name)) {
                    poolName = resolvePool(arg.name);
                }
                if (arg.type === 'Literal' && typeof arg.value === 'number' && arg.value > 1000) {
                    target = arg.value;
                }
            }

            if (!poolName || target === null) return;
            const pool = pools.get(poolName);
            if (!pool) return;
            if (resolvedPools.has(poolName)) return; // already resolved

            // Find the local decoder alias inside the IIFE
            let localDecoderName: string | null = null;
            if (callee.body?.type === 'BlockStatement') {
                for (const stmt of callee.body.body) {
                    if (stmt.type === 'VariableDeclaration') {
                        for (const decl of stmt.declarations) {
                            if (decl.id?.type === 'Identifier' && decl.init?.type === 'Identifier' &&
                                allDecoderNames.has(decl.init.name)) {
                                localDecoderName = decl.id.name;
                            }
                        }
                    }
                }
            }

            // Find the checksum expression inside the while(true) → try block
            let checksumExpr: AnyNode | null = null;

            simple(callee, {
                WhileStatement(whileNode: AnyNode) {
                    if (checksumExpr) return;
                    const whileBody = whileNode.body;
                    if (!whileBody) return;
                    const stmts = whileBody.type === 'BlockStatement' ? whileBody.body : [whileBody];
                    for (const stmt of stmts) {
                        if (stmt.type !== 'TryStatement' || !stmt.block?.body) continue;
                        for (const tryStmt of stmt.block.body) {
                            if (tryStmt.type === 'VariableDeclaration') {
                                for (const decl of tryStmt.declarations) {
                                    if (decl.init && (decl.init.type === 'BinaryExpression' || decl.init.type === 'UnaryExpression')) {
                                        checksumExpr = decl.init;
                                    }
                                }
                            }
                        }
                    }
                }
            });

            if (!checksumExpr) return;

            // Determine which decoder to use for evaluation
            const decoderInfo = decoders.values().next().value;
            if (!decoderInfo) return;
            const offset = decoderInfo.offset;

            // The decoder name used in the checksum (could be a local alias)
            const evalDecoderNames = new Set<string>(allDecoderNames);
            if (localDecoderName) evalDecoderNames.add(localDecoderName);

            // Brute-force all rotations
            const strings = pool.strings;
            for (let rot = 0; rot < strings.length; rot++) {
                const rotated = [...strings.slice(rot), ...strings.slice(0, rot)];
                const decoderFn = (n: number): string | undefined => {
                    const idx = n - offset;
                    return idx >= 0 && idx < rotated.length ? rotated[idx] : undefined;
                };

                const result = evaluateChecksumExpr(checksumExpr, decoderFn, evalDecoderNames);
                if (result !== null && Math.abs(result - target) < 1) {
                    resolvedPools.set(poolName, rotated);
                    markRemoved(node); // Remove the rotation IIFE
                    changed = true;
                    return;
                }
            }
        }
    });

    // If no rotation IIFE found, use the raw arrays
    for (const [name, pool] of pools) {
        if (!resolvedPools.has(name)) {
            resolvedPools.set(name, pool.strings);
        }
    }

    // Step 6: Inline all decoder calls throughout the AST
    simple(ast, {
        CallExpression(node: AnyNode) {
            if (node.callee?.type !== 'Identifier') return;
            const info = resolveDecoder(node.callee.name);
            if (!info) return;

            const args = node.arguments as AnyNode[];
            if (args.length < 1 || args[0].type !== 'Literal' || typeof args[0].value !== 'number') return;

            const pool = resolvedPools.get(info.poolName);
            if (!pool) return;

            const idx = args[0].value - info.offset;
            if (idx >= 0 && idx < pool.length) {
                replaceNode(node, literal(pool[idx]));
                changed = true;
            }
        }
    });

    // Step 7: Remove dead infrastructure (pool functions, decoder functions, aliases)
    if (changed) {
        // Remove pool function declarations
        for (const [, pool] of pools) {
            markRemoved(pool.node);
        }

        // Remove decoder function declarations
        for (const [, decoder] of decoders) {
            markRemoved(decoder.node);
        }

        // Remove alias variable declarations (const D = decoderFn, var stringPool = _0x2d96)
        const aliasNames = new Set([...decoderAliases.keys(), ...poolAliases.keys()]);
        simple(ast, {
            VariableDeclaration(node: AnyNode) {
                const remaining = node.declarations.filter((decl: AnyNode) => {
                    if (decl.id?.type === 'Identifier' && aliasNames.has(decl.id.name)) return false;
                    return true;
                });
                if (remaining.length === 0) {
                    markRemoved(node);
                } else if (remaining.length < node.declarations.length) {
                    node.declarations = remaining;
                    changed = true;
                }
            }
        });

        sweepRemoved(ast);
    }

    return changed;
}

function extractStringPool(node: AnyNode): string[] | null {
    const body = node.body;
    if (!body || body.type !== 'BlockStatement') return null;

    for (const stmt of body.body) {
        if (stmt.type !== 'VariableDeclaration') continue;
        for (const decl of stmt.declarations) {
            if (decl.init?.type !== 'ArrayExpression') continue;
            const elements = decl.init.elements as AnyNode[];
            if (elements.length < 10) continue;
            if (!elements.every((el: AnyNode) => el?.type === 'Literal' && typeof el.value === 'string')) continue;
            return elements.map((el: AnyNode) => el.value as string);
        }
    }

    return null;
}

function detectDecoderFunction(
    node: AnyNode,
    resolvePool: (name: string) => string | null
): { poolName: string; offset: number } | null {
    const body = node.body;
    if (!body || body.type !== 'BlockStatement') return null;
    if (!node.params?.length) return null;

    const firstParam = node.params[0];
    if (firstParam.type !== 'Identifier') return null;
    const paramName = firstParam.name;

    let poolName: string | null = null;
    let offset = 0;

    for (const stmt of body.body) {
        if (stmt.type === 'VariableDeclaration') {
            for (const decl of stmt.declarations) {
                // const arr = poolFn()
                if (decl.init?.type === 'CallExpression' && decl.init.callee?.type === 'Identifier') {
                    const resolved = resolvePool(decl.init.callee.name);
                    if (resolved) poolName = resolved;
                }
                // const idx = param - OFFSET
                if (decl.init?.type === 'BinaryExpression' && decl.init.operator === '-' &&
                    decl.init.left?.type === 'Identifier' && decl.init.left.name === paramName &&
                    decl.init.right?.type === 'Literal' && typeof decl.init.right.value === 'number') {
                    offset = decl.init.right.value;
                }
            }
        }

        // param = param - OFFSET (assignment form)
        if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'AssignmentExpression') {
            const expr = stmt.expression;
            if (expr.left?.type === 'Identifier' && expr.left.name === paramName &&
                expr.right?.type === 'BinaryExpression' && expr.right.operator === '-' &&
                expr.right.left?.type === 'Identifier' && expr.right.left.name === paramName &&
                expr.right.right?.type === 'Literal' && typeof expr.right.right.value === 'number') {
                offset = expr.right.right.value;
            }
        }

        // return arr[param - OFFSET] (inline offset in return)
        if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'MemberExpression') {
            const mem = stmt.argument;
            if (mem.computed && mem.property?.type === 'BinaryExpression' &&
                mem.property.operator === '-' &&
                mem.property.left?.type === 'Identifier' && mem.property.left.name === paramName &&
                mem.property.right?.type === 'Literal' && typeof mem.property.right.value === 'number') {
                offset = mem.property.right.value;
                if (mem.object?.type === 'Identifier') {
                    const resolved = resolvePool(mem.object.name);
                    if (resolved) poolName = resolved;
                }
            }
        }
    }

    if (!poolName) return null;
    return { poolName, offset };
}

function evaluateChecksumExpr(
    node: AnyNode,
    decoder: (n: number) => string | undefined,
    decoderNames: Set<string>
): number | null {
    if (!node) return null;

    switch (node.type) {
        case 'Literal':
            return typeof node.value === 'number' ? node.value : null;

        case 'UnaryExpression':
            if (node.operator === '-') {
                const v = evaluateChecksumExpr(node.argument, decoder, decoderNames);
                return v !== null ? -v : null;
            }
            if (node.operator === '+') return evaluateChecksumExpr(node.argument, decoder, decoderNames);
            return null;

        case 'BinaryExpression': {
            const left = evaluateChecksumExpr(node.left, decoder, decoderNames);
            const right = evaluateChecksumExpr(node.right, decoder, decoderNames);
            if (left === null || right === null) return null;
            switch (node.operator) {
                case '+': return left + right;
                case '-': return left - right;
                case '*': return left * right;
                case '/': return right !== 0 ? left / right : null;
                case '%': return right !== 0 ? left % right : null;
                default: return null;
            }
        }

        case 'CallExpression':
            // parseInt(decoderFn(N)) or parseInt(decoderFn(N), radix)
            if (node.callee?.type === 'Identifier' && node.callee.name === 'parseInt' &&
                node.arguments?.length >= 1) {
                const arg = node.arguments[0];
                if (arg.type === 'CallExpression' && arg.callee?.type === 'Identifier' &&
                    decoderNames.has(arg.callee.name) &&
                    arg.arguments?.length >= 1 &&
                    arg.arguments[0].type === 'Literal' && typeof arg.arguments[0].value === 'number') {
                    const decoded = decoder(arg.arguments[0].value);
                    if (decoded === undefined) return null;
                    const result = parseInt(decoded);
                    return isNaN(result) ? null : result;
                }
            }
            return null;

        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Layer 1a: Decode all literals (hex, unicode, base64)
// ---------------------------------------------------------------------------

function decodeLiterals(ast: AnyNode): boolean {
    let changed = false;

    simple(ast, {
        Literal(node: AnyNode) {
            if (typeof node.value === 'string' && node.raw) {
                const raw = node.raw as string;
                if (/\\x[0-9a-fA-F]{2}/.test(raw) || /\\u[0-9a-fA-F]{4}/.test(raw) || /\\u\{[0-9a-fA-F]+\}/.test(raw)) {
                    // node.value is already the decoded string, just update raw
                    node.raw = JSON.stringify(node.value);
                    changed = true;
                }
            }
            if (typeof node.value === 'number' && node.raw) {
                if ((node.raw as string).match(/^0[xX]/)) {
                    node.raw = String(node.value);
                    changed = true;
                }
            }
        },

        CallExpression(node: AnyNode) {
            if (
                node.callee?.type === 'Identifier' &&
                node.callee.name === 'atob' &&
                node.arguments?.length === 1 &&
                node.arguments[0].type === 'Literal' &&
                typeof node.arguments[0].value === 'string'
            ) {
                try {
                    const decoded = atob(node.arguments[0].value);
                    replaceNode(node, literal(decoded));
                    changed = true;
                } catch { /* invalid base64, skip */ }
            }
        }
    });

    return changed;
}

// ---------------------------------------------------------------------------
// Layer 1b: Resolve string arrays and rotation offsets
// ---------------------------------------------------------------------------

function resolveStringArrays(ast: AnyNode): boolean {
    let changed = false;

    // Phase 1: Find string array declarations
    const stringArrays = new Map<string, { strings: string[] }>();

    simple(ast, {
        VariableDeclarator(node: AnyNode) {
            if (node.id?.type !== 'Identifier') return;
            const init = node.init;
            if (!init || init.type !== 'ArrayExpression') return;

            const elements = init.elements as AnyNode[];
            if (elements.length < 3) return;
            if (!elements.every((el: AnyNode) => el?.type === 'Literal' && typeof el.value === 'string')) return;

            const name = node.id.name;
            const strings = elements.map((el: AnyNode) => el.value as string);
            stringArrays.set(name, { strings });
        }
    });

    if (stringArrays.size === 0) return false;

    // Phase 2: Detect rotation IIFEs — (function(arr, offset){ push/shift })(arrayRef, N)
    simple(ast, {
        ExpressionStatement(node: AnyNode) {
            const expr = node.expression;
            if (expr?.type !== 'CallExpression') return;
            const callee = expr.callee;
            if (callee?.type !== 'FunctionExpression' && callee?.type !== 'ArrowFunctionExpression') return;

            const args = expr.arguments as AnyNode[];
            if (args.length < 2) return;
            if (args[0].type !== 'Identifier') return;

            const arrayName = args[0].name;
            const entry = stringArrays.get(arrayName);
            if (!entry) return;

            if (args[1].type !== 'Literal' || typeof args[1].value !== 'number') return;
            const rotationCount = args[1].value;

            if (rotationCount > 0 && rotationCount < entry.strings.length * 2) {
                for (let i = 0; i < rotationCount; i++) {
                    entry.strings.push(entry.strings.shift()!);
                }
                markRemoved(node);
                changed = true;
            }
        }
    });

    // Phase 3: Detect accessor functions
    const accessors = new Map<string, { arrayName: string; offset: number }>();

    simple(ast, {
        FunctionDeclaration(node: AnyNode) {
            if (!node.id) return;
            const result = detectAccessorPattern(node, stringArrays);
            if (result) accessors.set(node.id.name, result);
        },
        VariableDeclarator(node: AnyNode) {
            if (node.id?.type !== 'Identifier') return;
            if (node.init?.type !== 'FunctionExpression' && node.init?.type !== 'ArrowFunctionExpression') return;
            const result = detectAccessorPattern(node.init, stringArrays);
            if (result) accessors.set(node.id.name, result);
        }
    });

    // Phase 4: Inline resolved strings
    simple(ast, {
        MemberExpression(node: AnyNode) {
            if (node.object?.type !== 'Identifier') return;
            const entry = stringArrays.get(node.object.name);
            if (!entry) return;

            if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'number') {
                const idx = node.property.value;
                if (idx >= 0 && idx < entry.strings.length) {
                    replaceNode(node, literal(entry.strings[idx]));
                    changed = true;
                }
            }
        },

        CallExpression(node: AnyNode) {
            if (node.callee?.type !== 'Identifier') return;
            const accessor = accessors.get(node.callee.name);
            if (!accessor) return;
            const entry = stringArrays.get(accessor.arrayName);
            if (!entry) return;

            const args = node.arguments as AnyNode[];
            if (args.length >= 1 && args[0].type === 'Literal' && typeof args[0].value === 'number') {
                const idx = args[0].value - accessor.offset;
                if (idx >= 0 && idx < entry.strings.length) {
                    replaceNode(node, literal(entry.strings[idx]));
                    changed = true;
                }
            }
        }
    });

    if (changed) sweepRemoved(ast);
    return changed;
}

function detectAccessorPattern(
    node: AnyNode,
    stringArrays: Map<string, { strings: string[] }>
): { arrayName: string; offset: number } | null {
    const body = node.body;
    if (!body || body.type !== 'BlockStatement' || !node.params?.length) return null;

    const firstParam = node.params[0];
    if (firstParam.type !== 'Identifier') return null;
    const paramName = firstParam.name;

    let foundOffset: number | null = null;

    for (const stmt of body.body) {
        if (stmt.type === 'ReturnStatement' && stmt.argument) {
            const result = matchArrayAccess(stmt.argument, paramName, stringArrays);
            if (result) return result;
        }

        if (stmt.type === 'ExpressionStatement') {
            const expr = stmt.expression;
            if (
                expr?.type === 'AssignmentExpression' &&
                expr.left?.type === 'Identifier' && expr.left.name === paramName &&
                expr.right?.type === 'BinaryExpression' && expr.right.operator === '-' &&
                expr.right.left?.type === 'Identifier' && expr.right.left.name === paramName &&
                expr.right.right?.type === 'Literal' && typeof expr.right.right.value === 'number'
            ) {
                foundOffset = expr.right.right.value;
            }
        }
    }

    if (foundOffset !== null) {
        for (const stmt of body.body) {
            if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'MemberExpression') {
                if (stmt.argument.object?.type === 'Identifier' && stringArrays.has(stmt.argument.object.name)) {
                    return { arrayName: stmt.argument.object.name, offset: foundOffset };
                }
            }
        }
    }

    return null;
}

function matchArrayAccess(
    node: AnyNode,
    paramName: string,
    stringArrays: Map<string, { strings: string[] }>
): { arrayName: string; offset: number } | null {
    if (node.type !== 'MemberExpression' || node.object?.type !== 'Identifier') return null;
    if (!stringArrays.has(node.object.name)) return null;

    const arrayName = node.object.name;

    if (
        node.property?.type === 'BinaryExpression' && node.property.operator === '-' &&
        node.property.left?.type === 'Identifier' && node.property.left.name === paramName &&
        node.property.right?.type === 'Literal' && typeof node.property.right.value === 'number'
    ) {
        return { arrayName, offset: node.property.right.value };
    }

    if (node.property?.type === 'Identifier' && node.property.name === paramName) {
        return { arrayName, offset: 0 };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Layer 1c: Constant folding
// ---------------------------------------------------------------------------

function constantFolding(ast: AnyNode): boolean {
    let changed = false;

    simple(ast, {
        BinaryExpression(node: AnyNode) {
            const { left, right, operator } = node;

            // String concatenation: "a" + "b" → "ab"
            if (operator === '+' && left?.type === 'Literal' && typeof left.value === 'string' &&
                right?.type === 'Literal' && typeof right.value === 'string') {
                replaceNode(node, literal(left.value + right.value));
                changed = true;
                return;
            }

            // Numeric arithmetic
            if (left?.type === 'Literal' && typeof left.value === 'number' &&
                right?.type === 'Literal' && typeof right.value === 'number') {
                let result: number | null = null;
                switch (operator) {
                    case '+': result = left.value + right.value; break;
                    case '-': result = left.value - right.value; break;
                    case '*': result = left.value * right.value; break;
                    case '/': if (right.value !== 0) result = left.value / right.value; break;
                    case '%': if (right.value !== 0) result = left.value % right.value; break;
                    case '**': result = left.value ** right.value; break;
                    case '|': result = left.value | right.value; break;
                    case '&': result = left.value & right.value; break;
                    case '^': result = left.value ^ right.value; break;
                    case '<<': result = left.value << right.value; break;
                    case '>>': result = left.value >> right.value; break;
                    case '>>>': result = left.value >>> right.value; break;
                }
                if (result !== null && Number.isFinite(result)) {
                    replaceNode(node, literal(result));
                    changed = true;
                    return;
                }
            }

            // Mixed string+number concatenation
            if (operator === '+') {
                if (left?.type === 'Literal' && typeof left.value === 'string' &&
                    right?.type === 'Literal' && typeof right.value === 'number') {
                    replaceNode(node, literal(left.value + String(right.value)));
                    changed = true;
                    return;
                }
                if (left?.type === 'Literal' && typeof left.value === 'number' &&
                    right?.type === 'Literal' && typeof right.value === 'string') {
                    replaceNode(node, literal(String(left.value) + right.value));
                    changed = true;
                    return;
                }
            }
        },

        UnaryExpression(node: AnyNode) {
            const arg = node.argument;
            // void 0 → undefined
            if (node.operator === 'void' && arg?.type === 'Literal' && arg.value === 0) {
                replaceNode(node, identifier('undefined'));
                changed = true;
                return;
            }
            // ! with any evaluable expression: ![] → false, !![] → true
            if (node.operator === '!') {
                if (isTruthy(arg)) {
                    replaceNode(node, literal(false));
                    changed = true;
                    return;
                }
                if (isFalsy(arg)) {
                    replaceNode(node, literal(true));
                    changed = true;
                    return;
                }
            }
            // + (numeric coercion): +true → 1, +false → 0, +"42" → 42, +[] → 0
            if (node.operator === '+') {
                if (arg?.type === 'Literal') {
                    if (typeof arg.value === 'boolean') {
                        replaceNode(node, literal(arg.value ? 1 : 0));
                        changed = true;
                        return;
                    }
                    if (typeof arg.value === 'string') {
                        const num = Number(arg.value);
                        if (!isNaN(num) && isFinite(num)) {
                            replaceNode(node, literal(num));
                            changed = true;
                            return;
                        }
                    }
                }
                if (arg?.type === 'ArrayExpression' && (!arg.elements || arg.elements.length === 0)) {
                    replaceNode(node, literal(0));
                    changed = true;
                    return;
                }
            }
            // - (negation): -5 literal
            if (node.operator === '-' && arg?.type === 'Literal' && typeof arg.value === 'number') {
                replaceNode(node, literal(-arg.value));
                changed = true;
                return;
            }
            // ~ (bitwise NOT)
            if (node.operator === '~' && arg?.type === 'Literal' && typeof arg.value === 'number') {
                replaceNode(node, literal(~arg.value));
                changed = true;
                return;
            }
            // typeof with literal: typeof "hello" → "string"
            if (node.operator === 'typeof' && arg?.type === 'Literal') {
                replaceNode(node, literal(typeof arg.value));
                changed = true;
                return;
            }
        },

        // obj["prop"] → obj.prop (when prop is a valid identifier)
        MemberExpression(node: AnyNode) {
            if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
                const prop = node.property.value;
                if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(prop) && !isReservedWord(prop)) {
                    node.computed = false;
                    node.property = identifier(prop);
                    changed = true;
                }
            }
        },

        // Simplify logical expressions with known truthy/falsy operands
        LogicalExpression(node: AnyNode) {
            const { left, right, operator } = node;
            if (operator === '&&') {
                if (isFalsy(left)) { replaceNode(node, left); changed = true; return; }
                if (isTruthy(left)) { replaceNode(node, right); changed = true; return; }
            }
            if (operator === '||') {
                if (isTruthy(left)) { replaceNode(node, left); changed = true; return; }
                if (isFalsy(left)) { replaceNode(node, right); changed = true; return; }
            }
            if (operator === '??') {
                // null ?? x → x, "value" ?? x → "value"
                if (left?.type === 'Literal' && left.value !== null) {
                    replaceNode(node, left); changed = true; return;
                }
                if (left?.type === 'Literal' && left.value === null) {
                    replaceNode(node, right); changed = true; return;
                }
                if (left?.type === 'Identifier' && left.name === 'undefined') {
                    replaceNode(node, right); changed = true; return;
                }
            }
        }
    });

    return changed;
}

const RESERVED = new Set([
    'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete',
    'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
    'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
    'void', 'while', 'with', 'class', 'const', 'enum', 'export', 'extends',
    'import', 'super', 'implements', 'interface', 'let', 'package', 'private',
    'protected', 'public', 'static', 'yield'
]);

function isReservedWord(word: string): boolean {
    return RESERVED.has(word);
}

// ---------------------------------------------------------------------------
// Layer 1c2: Resolve static built-in calls
// ---------------------------------------------------------------------------

function resolveStaticCalls(ast: AnyNode): boolean {
    let changed = false;

    simple(ast, {
        CallExpression(node: AnyNode) {
            // String.fromCharCode(n1, n2, ...)
            if (
                node.callee?.type === 'MemberExpression' &&
                node.callee.object?.type === 'Identifier' && node.callee.object.name === 'String' &&
                node.callee.property?.type === 'Identifier' && node.callee.property.name === 'fromCharCode' &&
                node.arguments?.length > 0
            ) {
                const args = node.arguments as AnyNode[];
                if (args.every((a: AnyNode) => a.type === 'Literal' && typeof a.value === 'number')) {
                    const chars = args.map((a: AnyNode) => String.fromCharCode(a.value as number));
                    replaceNode(node, literal(chars.join('')));
                    changed = true;
                    return;
                }
            }

            // parseInt("literal", radix?) / parseFloat("literal")
            if (
                node.callee?.type === 'Identifier' &&
                (node.callee.name === 'parseInt' || node.callee.name === 'parseFloat') &&
                node.arguments?.length >= 1 &&
                node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string'
            ) {
                if (node.callee.name === 'parseInt') {
                    const radix = node.arguments.length >= 2 &&
                        node.arguments[1].type === 'Literal' && typeof node.arguments[1].value === 'number'
                        ? node.arguments[1].value : undefined;
                    const result = parseInt(node.arguments[0].value, radix);
                    if (!isNaN(result) && isFinite(result)) {
                        replaceNode(node, literal(result));
                        changed = true;
                        return;
                    }
                } else {
                    const result = parseFloat(node.arguments[0].value);
                    if (!isNaN(result) && isFinite(result)) {
                        replaceNode(node, literal(result));
                        changed = true;
                        return;
                    }
                }
            }

            // "literal".charAt(n), "literal".charCodeAt(n), "literal".indexOf("x")
            if (
                node.callee?.type === 'MemberExpression' &&
                node.callee.object?.type === 'Literal' && typeof node.callee.object.value === 'string' &&
                node.callee.property?.type === 'Identifier' &&
                node.arguments?.length === 1 &&
                node.arguments[0].type === 'Literal'
            ) {
                const str = node.callee.object.value;
                const method = node.callee.property.name;
                const argVal = node.arguments[0].value;

                if (method === 'charAt' && typeof argVal === 'number' && argVal >= 0 && argVal < str.length) {
                    replaceNode(node, literal(str.charAt(argVal)));
                    changed = true;
                    return;
                }
                if (method === 'charCodeAt' && typeof argVal === 'number' && argVal >= 0 && argVal < str.length) {
                    replaceNode(node, literal(str.charCodeAt(argVal)));
                    changed = true;
                    return;
                }
                if (method === 'indexOf' && typeof argVal === 'string') {
                    replaceNode(node, literal(str.indexOf(argVal)));
                    changed = true;
                    return;
                }
            }

            // "literal".slice(n, m) / "literal".substring(n, m)
            if (
                node.callee?.type === 'MemberExpression' &&
                node.callee.object?.type === 'Literal' && typeof node.callee.object.value === 'string' &&
                node.callee.property?.type === 'Identifier' &&
                (node.callee.property.name === 'slice' || node.callee.property.name === 'substring')
            ) {
                const str = node.callee.object.value;
                const args = node.arguments as AnyNode[];
                if (args.length >= 1 && args.every((a: AnyNode) => a.type === 'Literal' && typeof a.value === 'number')) {
                    const start = args[0].value as number;
                    const end = args.length >= 2 ? args[1].value as number : undefined;
                    const result = node.callee.property.name === 'slice' ? str.slice(start, end) : str.substring(start, end);
                    replaceNode(node, literal(result));
                    changed = true;
                    return;
                }
            }

            // [elems].join("sep") where all elements are string/number literals
            if (
                node.callee?.type === 'MemberExpression' &&
                node.callee.object?.type === 'ArrayExpression' &&
                node.callee.property?.type === 'Identifier' && node.callee.property.name === 'join' &&
                node.arguments?.length === 1 &&
                node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string'
            ) {
                const elements = node.callee.object.elements as AnyNode[];
                if (elements.every((el: AnyNode) => el?.type === 'Literal' && (typeof el.value === 'string' || typeof el.value === 'number'))) {
                    const joined = elements.map((el: AnyNode) => String(el.value)).join(node.arguments[0].value);
                    replaceNode(node, literal(joined));
                    changed = true;
                    return;
                }
            }

            // Number("literal") with numeric string
            if (
                node.callee?.type === 'Identifier' && node.callee.name === 'Number' &&
                node.arguments?.length === 1 &&
                node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string'
            ) {
                const result = Number(node.arguments[0].value);
                if (!isNaN(result) && isFinite(result)) {
                    replaceNode(node, literal(result));
                    changed = true;
                    return;
                }
            }

            // Boolean(literal) → true/false
            if (
                node.callee?.type === 'Identifier' && node.callee.name === 'Boolean' &&
                node.arguments?.length === 1 &&
                node.arguments[0].type === 'Literal'
            ) {
                replaceNode(node, literal(Boolean(node.arguments[0].value)));
                changed = true;
                return;
            }
        }
    });

    return changed;
}

// ---------------------------------------------------------------------------
// Layer 1c3: Simplify sequence/comma expressions
// ---------------------------------------------------------------------------

function simplifySequences(ast: AnyNode): boolean {
    let changed = false;

    simple(ast, {
        // (0, fn)() → fn() — common indirect call pattern from bundlers
        CallExpression(node: AnyNode) {
            if (
                node.callee?.type === 'SequenceExpression' &&
                node.callee.expressions?.length === 2
            ) {
                const [first, second] = node.callee.expressions;
                if (!hasSideEffects(first)) {
                    node.callee = second;
                    changed = true;
                }
            }
        },

        // (a, b, c) → c when leading expressions have no side effects
        SequenceExpression(node: AnyNode) {
            if (!node.expressions || node.expressions.length < 2) return;

            const filtered = node.expressions.filter((expr: AnyNode, i: number) => {
                if (i === node.expressions.length - 1) return true; // always keep last
                return hasSideEffects(expr);
            });

            if (filtered.length < node.expressions.length) {
                if (filtered.length === 1) {
                    replaceNode(node, filtered[0]);
                } else {
                    node.expressions = filtered;
                }
                changed = true;
            }
        }
    });

    return changed;
}

function hasSideEffects(node: AnyNode): boolean {
    if (!node) return false;
    switch (node.type) {
        case 'Literal':
        case 'Identifier':
        case 'ThisExpression':
            return false;
        case 'ArrayExpression':
            return node.elements?.some((el: AnyNode) => el && hasSideEffects(el)) ?? false;
        case 'ObjectExpression':
            return node.properties?.some((p: AnyNode) => hasSideEffects(p.value)) ?? false;
        case 'UnaryExpression':
            if (node.operator === 'delete') return true;
            return hasSideEffects(node.argument);
        case 'BinaryExpression':
            return hasSideEffects(node.left) || hasSideEffects(node.right);
        default:
            return true; // conservative: assume side effects
    }
}

// ---------------------------------------------------------------------------
// Layer 1d: Unwrap eval / Function() calls
// ---------------------------------------------------------------------------

function unwrapEval(ast: AnyNode): boolean {
    let changed = false;

    ancestor(ast, {
        CallExpression(node: AnyNode, _state: unknown, ancestors: AnyNode[]) {
            // eval("code") → inline
            if (
                node.callee?.type === 'Identifier' && node.callee.name === 'eval' &&
                node.arguments?.length === 1 &&
                node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string'
            ) {
                try {
                    const parsed = parse(node.arguments[0].value, {
                        ecmaVersion: 'latest', sourceType: 'module'
                    }) as AnyNode;
                    if (parsed.body.length === 1 && parsed.body[0].type === 'ExpressionStatement') {
                        replaceNode(node, parsed.body[0].expression);
                        changed = true;
                    } else if (parsed.body.length > 0) {
                        // Replace the parent ExpressionStatement with the parsed statements
                        const parent = ancestors[ancestors.length - 2];
                        if (parent?.type === 'ExpressionStatement') {
                            const grandParent = ancestors[ancestors.length - 3];
                            if (grandParent && Array.isArray(grandParent.body)) {
                                const idx = grandParent.body.indexOf(parent);
                                if (idx !== -1) {
                                    grandParent.body.splice(idx, 1, ...parsed.body);
                                    changed = true;
                                }
                            }
                        }
                    }
                } catch { /* unparseable, skip */ }
            }
        },

        NewExpression(node: AnyNode) {
            // new Function("body") → (function() { body })
            if (node.callee?.type !== 'Identifier' || node.callee.name !== 'Function') return;
            const args = node.arguments as AnyNode[];
            if (args.length === 0) return;

            const bodyArg = args[args.length - 1];
            if (bodyArg.type !== 'Literal' || typeof bodyArg.value !== 'string') return;

            const paramNames = args.slice(0, -1)
                .map((a: AnyNode) => (a.type === 'Literal' && typeof a.value === 'string' ? a.value : ''))
                .join(',');

            try {
                const wrapped = `(function(${paramNames}) { ${bodyArg.value} })`;
                const parsed = parse(wrapped, { ecmaVersion: 'latest', sourceType: 'module' }) as AnyNode;
                if (parsed.body.length === 1 && parsed.body[0].type === 'ExpressionStatement') {
                    replaceNode(node, parsed.body[0].expression);
                    changed = true;
                }
            } catch { /* skip */ }
        }
    });

    return changed;
}

// ---------------------------------------------------------------------------
// Layer 1e: Remove dead code branches
// ---------------------------------------------------------------------------

function removeDeadCode(ast: AnyNode): boolean {
    let changed = false;

    ancestor(ast, {
        IfStatement(node: AnyNode, _state: unknown, ancestors: AnyNode[]) {
            const test = node.test;

            if (isFalsy(test)) {
                if (node.alternate) {
                    replaceNode(node, node.alternate);
                } else {
                    markRemoved(node);
                }
                changed = true;
                return;
            }

            if (isTruthy(test)) {
                replaceNode(node, node.consequent);
                changed = true;
                return;
            }
        },

        WhileStatement(node: AnyNode) {
            if (isFalsy(node.test)) {
                markRemoved(node);
                changed = true;
            }
        },

        ConditionalExpression(node: AnyNode) {
            if (isFalsy(node.test)) {
                replaceNode(node, node.alternate);
                changed = true;
            } else if (isTruthy(node.test)) {
                replaceNode(node, node.consequent);
                changed = true;
            }
        },

        BlockStatement(node: AnyNode) {
            const body = node.body as AnyNode[];
            let terminatorIdx = -1;

            for (let i = 0; i < body.length; i++) {
                const t = body[i].type;
                if (t === 'ReturnStatement' || t === 'ThrowStatement' ||
                    t === 'BreakStatement' || t === 'ContinueStatement') {
                    terminatorIdx = i;
                    break;
                }
            }

            if (terminatorIdx >= 0 && terminatorIdx < body.length - 1) {
                const after = body.slice(terminatorIdx + 1);
                const hoisted = after.filter((s: AnyNode) => s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration');
                const removable = after.filter((s: AnyNode) => s.type !== 'FunctionDeclaration' && s.type !== 'ClassDeclaration');

                if (removable.length > 0) {
                    node.body = [...hoisted, ...body.slice(0, terminatorIdx + 1)];
                    changed = true;
                }
            }
        },

        EmptyStatement(node: AnyNode) {
            markRemoved(node);
            changed = true;
        }
    });

    if (changed) sweepRemoved(ast);
    return changed;
}

function isFalsy(node: AnyNode): boolean {
    if (node.type === 'Literal') {
        if (node.value === false || node.value === 0 || node.value === '' || node.value === null) return true;
    }
    if (node.type === 'Identifier' && (node.name === 'undefined' || node.name === 'NaN')) return true;
    if (node.type === 'UnaryExpression' && node.operator === 'void') return true;
    // !truthy is falsy (e.g. ![] → false)
    if (node.type === 'UnaryExpression' && node.operator === '!' && isTruthy(node.argument)) return true;
    return false;
}

function isTruthy(node: AnyNode): boolean {
    if (node.type === 'Literal') {
        if (node.value === true) return true;
        if (typeof node.value === 'number' && node.value !== 0 && !isNaN(node.value)) return true;
        if (typeof node.value === 'string' && node.value !== '') return true;
    }
    if (node.type === 'ArrayExpression') return true;
    if (node.type === 'ObjectExpression') return true;
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return true;
    // !falsy is truthy (e.g. !0 → true, !false → true)
    if (node.type === 'UnaryExpression' && node.operator === '!' && isFalsy(node.argument)) return true;
    return false;
}
