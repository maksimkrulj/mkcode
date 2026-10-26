#!/usr/bin/env node
import { main } from "../dist/src/cli/main.js";

process.exitCode = await main(process.argv.slice(2));
