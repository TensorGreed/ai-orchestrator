#!/usr/bin/env node
/**
 * Promise misuse check for apps/api (and any extra tsconfig projects given as arguments).
 *
 * Every store method is async, so a forgotten `await` no longer fails to compile when the value is used where a
 * Promise is allowed: as a statement, as a condition, in `&&` / `||` / `??`, in a template, as a spread, as an
 * argument typed `unknown`, or as a callback whose caller ignores what it returns. This walks the TypeScript
 * program and reports those places:
 *
 *   floating        a Promise-valued expression statement (not awaited, returned, voided or chained with .catch/.then)
 *   condition       a Promise used as a condition or as an operand of `!`, `&&`, `||` or `??`; this includes a
 *                   value typed as a union of a Promise and a plain value (`T | Promise<T>`,
 *                   `T | null | Promise<T | null>`), the type of a callback that may answer either way
 *   compared        a Promise compared with `===` / `!==` / `==` / `!=` / `<` / `>` (always the same answer)
 *   stringified     a Promise inside a template literal or a string concatenation
 *   spread          a Promise spread into an object or array
 *   try-return      `return promise` inside a try block whose catch or finally should see its rejection, or inside
 *                   a catch block followed by a finally
 *   untyped-arg     a Promise passed to a parameter typed `unknown` / `any` / a bare type parameter (e.g. `expect(x)`)
 *   void-callback   an async function passed where the caller's type says the callback returns `void`
 *   array-callback  an async callback given to forEach / filter / some / every / find / findIndex / sort / reduce,
 *                   or to map when the result is not handed to Promise.all / Promise.allSettled
 *
 * A deliberate case is kept by a comment on the line before (or the same line): `// promise-ok: <why>`.
 * Usage: node scripts/check-floating-promises.mjs [--only] [extra tsconfig.json ...]   (exit 1 when anything is reported)
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");
// `--only a/tsconfig.json …` checks just those projects (the checker's own fixture test uses it).
const args = process.argv.slice(2);
const only = args[0] === "--only";
const extra = (only ? args.slice(1) : args).map((p) => path.resolve(p));
const projects = only ? extra : [path.join(apiRoot, "tsconfig.json"), ...extra];

const ARRAY_NEVER_ASYNC = new Set(["forEach", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "sort", "toSorted", "reduce", "reduceRight", "flatMap"]);
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
const NOT_PROMISES = new Set(["FastifyReply", "FastifyInstance"]);

let findings = 0;
const seen = new Set();

for (const project of projects) {
  const projectDir = path.dirname(project);
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(project, ts.sys.readFile).config, ts.sys, projectDir);
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const checker = program.getTypeChecker();

  const isThenable = (type) => {
    if (!type) return false;
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    const parts = type.isUnion() ? type.types : [type];
    return parts.some((part) => {
      if (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
      // Fastify's reply is thenable (it resolves when the response is sent) but is never awaited by design.
      const named = (t) => NOT_PROMISES.has((t.getSymbol() ?? t.aliasSymbol)?.getName());
      if (named(part) || (part.isIntersection() && part.types.some(named))) return false;
      const then = checker.getPropertyOfType(part, "then");
      if (!then) return false;
      const thenType = checker.getTypeOfSymbolAtLocation(then, then.valueDeclaration ?? then.declarations?.[0]);
      return thenType.getCallSignatures().length > 0;
    });
  };
  const typeOf = (node) => checker.getTypeAtLocation(node);
  // A condition on `Promise | undefined` is an existence check; on a Promise (or `T | Promise<T>`) it is a bug.
  const alwaysTruthyThenable = (type) => {
    if (!isThenable(type)) return false;
    const parts = type.isUnion() ? type.types : [type];
    return !parts.some((part) => part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void));
  };
  // The value of a call (`f?.()` included), or a variable set from one: its `undefined` is a missing
  // function, not a missing promise, so `Promise | undefined` there is still an un-awaited result.
  // Every signature of the callee (an optional callee without its `undefined`) returns a promise.
  const callAlwaysPromise = (call) => {
    const callee = checker.getNonNullableType(typeOf(call.expression));
    const signatures = callee.getCallSignatures();
    return signatures.length > 0 && signatures.every((signature) => alwaysTruthyThenable(checker.getReturnTypeOfSignature(signature)));
  };
  const fromCall = (node) => {
    const expr = strip(node);
    if (ts.isCallExpression(expr)) return callAlwaysPromise(expr);
    if (!ts.isIdentifier(expr)) return false;
    const declaration = checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
    const init = strip(declaration.initializer);
    return ts.isCallExpression(init) && callAlwaysPromise(init);
  };
  // `T | null | Promise<T | null>`: a callback that may answer sync or async. Testing it without `await` tests
  // the Promise, never the value. (`Promise | undefined` alone is an existence check and stays allowed.)
  const mixedThenable = (type) => {
    if (!type.isUnion() || !isThenable(type)) return false;
    return type.types.some((part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) && !isThenable(part));
  };
  const misusedThenable = (node) => {
    const type = typeOf(strip(node));
    return isThenable(type) && (fromCall(node) || alwaysTruthyThenable(type) || mixedThenable(type));
  };
  // A `return` inside the try block of the same function, where a catch or finally exists to see the rejection,
  // or inside its catch block when a finally follows (the finally runs before the promise settles).
  const insideTryBlock = (node) => {
    let child = node;
    for (let p = node.parent; p; child = p, p = p.parent) {
      if (ts.isFunctionLike(p) || ts.isClassStaticBlockDeclaration?.(p)) return false;
      if (ts.isTryStatement(p) && p.tryBlock === child) return true;
      if (ts.isCatchClause(p) && ts.isTryStatement(p.parent) && p.parent.finallyBlock) return true;
    }
    return false;
  };
  // `p.catch(handler)`, `p.then(ok, fail)` and `p.finally(...)` after one of those handle the rejection.
  const handled = (expr) => {
    if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return false;
    const name = expr.expression.name.text;
    if (name === "catch") return true;
    if (name === "then" && expr.arguments.length >= 2) return true;
    if (name === "finally") return handled(strip(expr.expression.expression));
    return false;
  };
  const strip = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
    return node;
  };
  const returnsOnlyVoid = (fnType) => {
    const sigs = fnType.getCallSignatures();
    if (!sigs.length) return false;
    return sigs.every((sig) => {
      const ret = sig.getReturnType();
      return !!(ret.flags & ts.TypeFlags.Void) && !ret.isUnion();
    });
  };
  const isAsyncFn = (node) => (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (!!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) || isThenable(checker.getSignaturesOfType(typeOf(node), ts.SignatureKind.Call)[0]?.getReturnType()));

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (!sf.fileName.startsWith(projectDir + path.sep)) continue;
    const lines = sf.text.split("\n");
    const report = (node, kind, detail) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      if (/promise-ok:/.test(lines[line] ?? "") || /promise-ok:/.test(lines[line - 1] ?? "")) return;
      const key = `${sf.fileName}:${line}:${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings += 1;
      const text = node.getText(sf).replace(/\s+/g, " ");
      console.log(`${path.relative(process.cwd(), sf.fileName)}:${line + 1}  ${kind}  ${detail ?? ""}${text.length > 110 ? `${text.slice(0, 110)}…` : text}`);
    };

    const visit = (node) => {
      // floating statement
      if (ts.isExpressionStatement(node)) {
        const expr = strip(node.expression);
        if (!ts.isVoidExpression(expr) && !ts.isAwaitExpression(expr) && !handled(expr) && !(ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) && isThenable(typeOf(expr))) {
          report(node, "floating");
        }
      }
      // `return promise` inside try: the function returns before the promise settles, so its rejection skips the catch
      if (ts.isReturnStatement(node) && node.expression && !ts.isAwaitExpression(strip(node.expression)) && isThenable(typeOf(strip(node.expression))) && insideTryBlock(node)) {
        report(node, "try-return");
      }
      // conditions and logical operands
      const condOf = ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression
        : ts.isForStatement(node) ? node.condition
          : ts.isConditionalExpression(node) ? node.condition
            : ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken ? node.operand
              : undefined;
      if (condOf && misusedThenable(condOf)) report(condOf, "condition");
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
          if (misusedThenable(node.left)) report(node.left, "condition");
          if (op !== ts.SyntaxKind.QuestionQuestionToken && misusedThenable(node.right) && (ts.isIfStatement(node.parent) || ts.isConditionalExpression(node.parent) || ts.isPrefixUnaryExpression(node.parent) || ts.isBinaryExpression(node.parent))) report(node.right, "condition");
        }
        // Comparing a Promise with a value (`=== null`, `!== undefined`, `> 0`) is always the same answer.
        const COMPARISONS = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken];
        if (COMPARISONS.includes(op)) {
          for (const side of [node.left, node.right]) if (misusedThenable(side)) report(side, "compared");
        }
        if (op === ts.SyntaxKind.PlusToken) {
          const lt = typeOf(node.left), rt = typeOf(node.right);
          const stringy = (t) => !!(t.flags & ts.TypeFlags.StringLike);
          if ((isThenable(lt) && stringy(rt)) || (isThenable(rt) && stringy(lt))) report(node, "stringified");
        }
      }
      if (ts.isTemplateSpan(node) && isThenable(typeOf(strip(node.expression)))) report(node.expression, "stringified");
      if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isThenable(typeOf(strip(node.expression)))) report(node, "spread");

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const sig = checker.getResolvedSignature(node);
        const callee = ts.isCallExpression(node) ? node.expression : node.expression;
        const calleeName = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
        const calleeObject = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : "";
        const isCombinator = calleeObject === "Promise" && (PROMISE_COMBINATORS.has(calleeName) || calleeName === "resolve");
        (node.arguments ?? []).forEach((arg, index) => {
          const a = strip(arg);
          // async callbacks
          if (ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) {
            const argType = typeOf(a);
            const argSigs = argType.getCallSignatures();
            const asyncCallback = (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) ? isAsyncFn(a) : argSigs.length > 0 && argSigs.every((s) => isThenable(s.getReturnType()));
            if (asyncCallback) {
              if (ts.isPropertyAccessExpression(callee) && ARRAY_NEVER_ASYNC.has(calleeName) && checker.isArrayLikeType(typeOf(callee.expression))) {
                report(arg, "array-callback", `.${calleeName}(async …): `);
              } else if (ts.isPropertyAccessExpression(callee) && calleeName === "map" && checker.isArrayLikeType(typeOf(callee.expression))) {
                let p = node.parent;
                while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) p = p.parent;
                const handed = (p && ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === "Promise" && PROMISE_COMBINATORS.has(p.expression.name.text));
                const kept = p && (ts.isVariableDeclaration(p) || ts.isReturnStatement(p) || ts.isArrowFunction(p));
                if (!handed && !kept) report(arg, "array-callback", ".map(async …) not given to Promise.all: ");
              } else if (sig) {
                const param = sig.parameters[Math.min(index, sig.parameters.length - 1)];
                if (param) {
                  const paramType = checker.getTypeOfSymbolAtLocation(param, node);
                  const nonNull = checker.getNonNullableType(paramType);
                  const candidates = nonNull.isUnion() ? nonNull.types : [nonNull];
                  const fnCandidates = candidates.filter((t) => t.getCallSignatures().length > 0);
                  if (calleeName !== "register" && fnCandidates.length && fnCandidates.every(returnsOnlyVoid)) report(arg, "void-callback", `${calleeName}(…): `);
                }
              }
            }
          }
          // promise into an unknown/any/type-parameter parameter
          if (!isCombinator && sig && isThenable(typeOf(a)) && !ts.isArrowFunction(a) && !ts.isFunctionExpression(a)) {
            const param = sig.parameters[Math.min(index, sig.parameters.length - 1)];
            const decl = param?.valueDeclaration;
            if (decl && ts.isParameter(decl)) {
              const declared = decl.type;
              const declaredType = declared ? checker.getTypeFromTypeNode(declared) : undefined;
              const loose = !declared
                || !!(declaredType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
                || (declaredType.isTypeParameter() && !!sig.declaration?.typeParameters?.some((tp) => checker.getTypeAtLocation(tp) === declaredType))
                || (ts.isTypeReferenceNode(declared) && declared.typeName.getText() === "Object");
              const mentionsPromise = declared && /Promise|PromiseLike|Thenable/.test(declared.getText());
              const viaExpect = calleeName === "expect" && ts.isPropertyAccessExpression(node.parent) && (node.parent.name.text === "resolves" || node.parent.name.text === "rejects");
              if (loose && !mentionsPromise && !viaExpect && !decl.dotDotDotToken) report(arg, "untyped-arg", `${calleeName}(…): `);
            }
          }
        });
      }
      // async function assigned to a property typed as void-returning
      if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(strip(node.initializer)) || ts.isFunctionExpression(strip(node.initializer))) && isAsyncFn(strip(node.initializer))) {
        const ct = checker.getContextualType(node.initializer);
        if (ct) {
          const nonNull = checker.getNonNullableType(ct);
          const candidates = (nonNull.isUnion() ? nonNull.types : [nonNull]).filter((t) => t.getCallSignatures().length > 0);
          if (candidates.length && candidates.every(returnsOnlyVoid)) report(node, "void-callback", `${node.name.getText(sf)}: `);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (findings) {
  console.log(`\n${findings} promise misuse finding(s). Await the value, or mark a deliberate case with // promise-ok: <why>.`);
  process.exit(1);
}
console.log("No promise misuse found.");
