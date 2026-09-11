// Reduced R8/JVM mechanism test. This does not run Android, Room or WorkManager.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './fixture.mjs';

const exec = promisify(execFile);
const command = async (file, args) => {
  try { const r = await exec(file, args, { timeout: 30000, maxBuffer: 1024 * 1024 }); return { exitCode: 0, stdout: r.stdout, stderr: r.stderr }; }
  catch (e) { if (typeof e.code !== 'number') throw e; return { exitCode: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
};
const java = (toolchain, name) => path.join(toolchain.javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
export async function inspectToolchain(r8Jar, javaHome) {
  if (!r8Jar || !javaHome) throw new Error('Provide --r8-jar and --java-home (or MASON_EVAL_R8_JAR / MASON_EVAL_JAVA_HOME). No automatic downloads.');
  const toolchain = { r8Jar: await fs.realpath(r8Jar), javaHome: await fs.realpath(javaHome) };
  toolchain.digest = digest(await fs.readFile(toolchain.r8Jar));
  const r8 = await command(java(toolchain, 'java'), ['-cp', toolchain.r8Jar, 'com.android.tools.r8.R8', '--version']);
  const jdk = await command(java(toolchain, 'javac'), ['-version']);
  if (r8.exitCode || jdk.exitCode) throw new Error('R8/JDK unavailable: ' + r8.stderr + jdk.stderr);
  return { ...toolchain, r8Version: r8.stdout.trim(), javacVersion: (jdk.stdout + jdk.stderr).trim() };
}

export function parseConfiguration(text) {
  const app = JSON.parse(text);
  if (!app || Object.keys(app).sort().join() !== ['backgroundEnabled', 'jobs', 'requestedBackground', 'schedulerDependency'].sort().join()
    || ['backgroundEnabled', 'requestedBackground', 'schedulerDependency'].some(k => typeof app[k] !== 'boolean')
    || !Array.isArray(app.jobs) || app.jobs.length > 10 || app.jobs.some(j => typeof j !== 'string' || !/^[a-z]{1,30}$/.test(j))
    || new Set(app.jobs).size !== app.jobs.length) throw new Error('Invalid application configuration');
  return app;
}

export function validateKeepRules(text) {
  if (text.length > 4000) throw new Error('Keep rules exceed fixture limit');
  const clean = text.replace(/#[^\n]*/g, '').trim();
  // Accept several actual keep-rule forms without allowing file inclusion,
  // output redirection, disabling the shrinker, or arbitrary R8 directives.
  const rule = /-keep(?:classmembers)?(?:,allowoptimization)?\s+class\s+[A-Za-z_$*][A-Za-z0-9_.$*]*(?:\s+extends\s+[A-Za-z_$*][A-Za-z0-9_.$*]*)?\s*\{\s*(?:(?:public\s+)?<init>\(\)|\*)\s*;\s*\}/gy;
  let offset = 0;
  while (offset < clean.length) {
    rule.lastIndex = offset;
    const match = rule.exec(clean);
    if (!match) throw new Error('Unsupported keep rule. Only class/constructor/member keep declarations are allowed in this fixture.');
    offset = rule.lastIndex;
    while (/\s/.test(clean[offset] ?? '') && offset < clean.length) offset++;
  }
  return text;
}

export async function runStartup(appText, keepText, toolchain, mode = 'release') {
  const app = parseConfiguration(appText), rules = validateKeepRules(keepText);
  if (!['debug', 'release'].includes(mode)) throw new Error('Unknown build mode');
  if (digest(await fs.readFile(toolchain.r8Jar)) !== toolchain.digest) throw new Error('R8 artifact changed after preflight');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mason-r8-'));
  try {
    await fs.mkdir(path.join(root, 'fixture'));
    await fs.writeFile(path.join(root, 'fixture/Main.java'), `package fixture;
public class Main {
  public static void main(String[] args) throws Exception {
    if (Boolean.getBoolean("scheduler")) Class.forName(System.getProperty("database")).getDeclaredConstructor().newInstance();
    System.out.println("APPLICATION_STARTED");
    if (Boolean.getBoolean("background") && Boolean.getBoolean("scheduler")) System.out.println("JOBS:" + System.getProperty("jobs"));
  }
}`);
    await fs.writeFile(path.join(root, 'fixture/GeneratedDatabase.java'), 'package fixture; public class GeneratedDatabase { public GeneratedDatabase() {} public void marker() {} }');
    const stages = [];
    stages.push(await command(java(toolchain, 'javac'), ['--release', '11', path.join(root, 'fixture/Main.java'), path.join(root, 'fixture/GeneratedDatabase.java')]));
    stages.push(await command(java(toolchain, 'jar'), ['cf', path.join(root, 'input.jar'), '-C', root, 'fixture/Main.class', '-C', root, 'fixture/GeneratedDatabase.class']));
    if (stages.some(s => s.exitCode)) throw new Error('Fixture compilation failed: ' + JSON.stringify(stages));
    if (mode === 'release') {
      await fs.writeFile(path.join(root, 'rules.pro'), '-keep class fixture.Main { public static void main(java.lang.String[]); }\n-keep,allowoptimization class fixture.GeneratedDatabase { public void marker(); }\n' + rules);
      const shrink = await command(java(toolchain, 'java'), ['-cp', toolchain.r8Jar, 'com.android.tools.r8.R8', '--release', '--classfile', '--lib', toolchain.javaHome,
        '--pg-conf', path.join(root, 'rules.pro'), '--output', path.join(root, 'release.jar'), path.join(root, 'input.jar')]);
      if (shrink.exitCode) return { available: true, pass: false, phase: 'shrink', mode, ...shrink };
    }
    const result = await command(java(toolchain, 'java'), [`-Dscheduler=${app.schedulerDependency}`, `-Dbackground=${app.backgroundEnabled}`,
      '-Ddatabase=fixture.GeneratedDatabase', '-Djobs=' + app.jobs.join(','), '-cp', path.join(root, mode === 'release' ? 'release.jar' : 'input.jar'), 'fixture.Main']);
    return { available: true, pass: result.exitCode === 0 && result.stdout.includes('APPLICATION_STARTED'), phase: 'startup', mode, ...result };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
