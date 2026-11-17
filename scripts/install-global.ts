import { execFileSync } from 'node:child_process';
import { lstatSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
}

function main(): void {
  console.log('==> 1. 构建项目产物 (pnpm build)...');
  execFileSync('pnpm', ['build'], { stdio: 'inherit' });

  console.log('==> 2. 生成物理安装包 (npm pack)...');
  const packOutput = run('npm', ['pack']);
  const tarballName = packOutput.split('\n').filter(Boolean).pop()?.trim();
  if (!tarballName || !tarballName.endsWith('.tgz')) {
    throw new Error(`npm pack 未能生成预期的 tarball: ${packOutput}`);
  }
  const tarballPath = resolve(process.cwd(), tarballName);
  console.log(`    已生成: ${tarballName}`);

  try {
    console.log(`==> 3. 安装到全局环境 (npm install -g ${tarballName})...`);
    execFileSync('npm', ['install', '-g', tarballPath], { stdio: 'inherit' });

    console.log('==> 4. 验证全局安装隔离性...');
    const globalRoot = run('npm', ['root', '-g']);
    const targetDir = resolve(globalRoot, 'ai-workflow');
    const stat = lstatSync(targetDir);

    if (stat.isSymbolicLink()) {
      throw new Error(`隔离性校验失败：${targetDir} 仍为符号链接！`);
    }
    console.log(`    全局路径: ${targetDir} (实体目录，非软链接)`);

    const version = run('ai-workflow', ['--version']);
    console.log(`    全局版本: ${version}`);
    console.log('==> 全局环境物理隔离安装完成！本地开发与构建不会再干扰全局环境。');
  } finally {
    try {
      unlinkSync(tarballPath);
    } catch {
      // 忽略清理异常
    }
  }
}

try {
  main();
} catch (err: unknown) {
  console.error('全局安装失败:', err);
  process.exit(1);
}
