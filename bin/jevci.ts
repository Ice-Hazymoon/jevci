#!/usr/bin/env node
import { run } from '../src/cli.js';

function exit(code: number): void {
    process.exitCode = code;
    // A judge request still retrying after its answer stopped mattering must not hold the process open.
    setTimeout(() => process.exit(code), 1000).unref();
}

run(process.argv.slice(2)).then(exit).catch((err: unknown) => {
    console.error(`jevci: ${err instanceof Error ? err.message : String(err)}`);
    exit(2);
});
