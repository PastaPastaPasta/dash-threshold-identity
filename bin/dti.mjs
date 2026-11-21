#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (e) => {
    console.error(`error: ${e.message}`);
    if (process.env.DTI_DEBUG) console.error(e.stack);
    process.exit(1);
  },
);
