import path from 'node:path';
import type { EngineeringValidationPurpose } from './contracts.js';

export function inferEngineeringValidationPurpose(nameInput: string): EngineeringValidationPurpose {
  const name = nameInput.trim().toLocaleLowerCase('en-US');
  if (/type[-_ ]?check|tsc/.test(name)) return 'typecheck';
  if (/\btest|vitest|jest|vstest|spec\b/.test(name)) return 'test';
  if (/\blint|eslint/.test(name)) return 'lint';
  if (/\bbuild|compile|msbuild/.test(name)) return 'build';
  return 'custom';
}

function executableName(command: string): string {
  return path.basename(command).toLocaleLowerCase('en-US').replace(/\.(?:exe|cmd|bat)$/i, '');
}

function arg(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase('en-US') ?? '';
}

function packageScript(args: readonly string[], script: string): boolean {
  const first = arg(args[0]);
  const second = arg(args[1]);
  return first === script || (first === 'run' && second === script);
}

export function commandMatchesEngineeringValidationPurpose(
  purpose: EngineeringValidationPurpose,
  command: string,
  args: readonly string[]
): boolean {
  if (purpose === 'custom') return true;
  const exe = executableName(command);
  const first = arg(args[0]);
  if (purpose === 'build') {
    if (exe === 'dotnet') return first === 'build' || first === 'msbuild';
    if (exe === 'msbuild') return true;
    if (['npm', 'pnpm', 'yarn'].includes(exe)) return packageScript(args, 'build');
    return false;
  }
  if (purpose === 'test') {
    if (exe === 'dotnet') return first === 'test' || first === 'vstest';
    if (['vstest.console', 'vstest.console.x86'].includes(exe)) return true;
    if (['npm', 'pnpm', 'yarn'].includes(exe)) return packageScript(args, 'test');
    if (exe === 'npx') return ['vitest', 'jest'].includes(first);
    return ['vitest', 'jest'].includes(exe);
  }
  if (purpose === 'typecheck') {
    if (['npm', 'pnpm', 'yarn'].includes(exe)) return packageScript(args, 'typecheck');
    if (exe === 'npx') return first === 'tsc' && args.some(item => arg(item) === '--noemit');
    return exe === 'tsc' && args.some(item => arg(item) === '--noemit');
  }
  if (purpose === 'lint') {
    if (['npm', 'pnpm', 'yarn'].includes(exe)) return packageScript(args, 'lint');
    if (exe === 'npx') return first === 'eslint';
    return exe === 'eslint';
  }
  return false;
}
