const os = require('os');
const fs = require('fs');
const path = require('path');
const {execFile, spawn} = require('child_process');
const {GitProcess} = require(process.env.ATOM_GITHUB_DUGITE_PATH);

const atomTmp = process.env.ATOM_GITHUB_TMP || '';
const diagnosticsEnabled = process.env.GIT_TRACE && process.env.GIT_TRACE.length > 0 && atomTmp.length > 0;
const workdirPath = process.env.ATOM_GITHUB_WORKDIR_PATH;
const pinentryLauncher = process.env.ATOM_GITHUB_PINENTRY_LAUNCHER;
const inSpecMode = process.env.ATOM_GITHUB_SPEC_MODE === 'true';

const DEFAULT_GPG = 'gpg';
const ORIGINAL_GPG_HOME = process.env.GNUPGHOME || path.join(os.homedir(), '.gnupg');
const GPG_TMP_HOME = path.join(atomTmp, 'gpg-home');

let logStream = null;

async function main() {
  let exitCode = 1;
  try {
    const [gpgProgram, gpgStdin] = await Promise.all([
      getGpgProgram(), getStdin(),
    ]);

    const native = await tryNativePinentry(gpgProgram, gpgStdin);
    if (native.success) {
      exitCode = native.exitCode;
    } else {
      const atom = await tryAtomPinentry(gpgProgram, gpgStdin);
      exitCode = atom.exitCode;
    }
  } catch (err) {
    log(`Failed with error:\n${err}`);
  } finally {
    await cleanup();
    process.exit(exitCode);
  }
}

/*
 * Read all information written to this process' stdin.
 */
function getStdin() {
  return new Promise((resolve, reject) => {
    let stdin = '';

    process.stdin.setEncoding('utf8');

    process.stdin.on('data', chunk => {
      stdin += chunk;
    });

    process.stdin.on('end', () => resolve(stdin));
    process.stdin.on('error', reject);
  });
}

/*
 * Discover the real GPG program that git is configured to use.
 */
async function getGpgProgram() {
  const env = {GIT_CONFIG_PARAMETERS: ''};

  const {stdout} = await GitProcess.exec(['config', 'gpg.program'], workdirPath, {env});

  if (stdout.length > 0) {
    log(`Discovered gpg program ${stdout} from non-system git configuration.`);
    return stdout;
  }

  const systemGpgProgram = await getSystemGpgProgram();

  if (systemGpgProgram.length > 0) {
    log(`Discovered gpg program ${systemGpgProgram} from system git configuration.`);
    return systemGpgProgram;
  }

  log('Using default gpg program.');
  return DEFAULT_GPG;
}

/*
 * Discover a GPG program configured in the --system git status, if any.
 */
function getSystemGpgProgram() {
  if (inSpecMode) {
    // Skip system configuration in spec mode to maintain reproduceability across systems.
    return '';
  }

  const env = {
    GIT_CONFIG_PARAMETERS: '',
    PATH: process.env.ATOM_GITHUB_ORIGINAL_PATH || '',
  };

  return new Promise(resolve => {
    execFile('git', ['config', '--system', 'gpg.program'], {env}, (error, stdout, stderr) => {
      resolve(stdout || '');
    });
  });
}

async function tryNativePinentry(gpgProgram, gpgStdin) {
  log('Attempting to execute gpg with native pinentry.');
  try {
    const exitCode = await runGpgProgram(gpgProgram, ORIGINAL_GPG_HOME, gpgStdin, {});
    return {success: true, exitCode};
  } catch (err) {
    // Interpret the nature of the failure.
    const killedBySignal = err.signal !== null;
    const badPassphrase = /Bad passphrase/.test(err.stderr);
    const cancelledByUser = /Operation cancelled/.test(err.stderr);

    if (killedBySignal || badPassphrase || cancelledByUser) {
      // Continue dying.
      process.stderr.write(err.stderr);
      process.stdout.write(err.stdout);
      throw err;
    }

    log('Native pinentry failed. This is ok.');
    return {success: false, exitCode: err.code};
  }
}

async function tryAtomPinentry(gpgProgram, gpgStdin) {
  log('Attempting to execute gpg with Atom pinentry.');

  await createIsolatedGpgHome();
  const env = await startIsolatedAgent();
  const exitCode = await runGpgProgram(gpgProgram, GPG_TMP_HOME, gpgStdin, env);
  return {success: true, exitCode};
}

/*
 * Launch a temporary GPG agent with an independent --homedir and a --pinentry-program that's overridden to use our
 * Atom-backed gpg-pinentry.sh.
 */
async function createIsolatedGpgHome() {
  log(`Creating an isolated GPG home ${GPG_TMP_HOME}.`);
  await new Promise((resolve, reject) => {
    fs.mkdir(GPG_TMP_HOME, 0o700, err => (err ? reject(err) : resolve()));
  });
  return copyGpgHome();
}

function copyGpgHome() {
  log(`Copying GPG home from ${ORIGINAL_GPG_HOME} to ${GPG_TMP_HOME}.`);

  async function copyGpgEntry(subpath, entry) {
    const fullPath = path.join(ORIGINAL_GPG_HOME, subpath, entry);
    const destPath = path.join(GPG_TMP_HOME, subpath, entry);

    const stat = await new Promise((resolve, reject) => {
      fs.lstat(fullPath, (err, statResult) => (err ? reject(err) : resolve(statResult)));
    });

    if (stat.isFile()) {
      await new Promise((resolve, reject) => {
        const rd = fs.createReadStream(fullPath);
        rd.on('error', reject);

        const wd = fs.createWriteStream(destPath);
        wd.on('error', reject);
        wd.on('close', resolve);

        rd.pipe(wd);
      });
    } else if (stat.isDirectory()) {
      const subdir = path.join(subpath, entry);
      await new Promise((resolve, reject) => {
        fs.mkdir(destPath, 0o700, err => (err ? reject(err) : resolve()));
      });

      await copyGpgDirectory(subdir);
    }
  }

  async function copyGpgDirectory(subpath) {
    const dirPath = path.join(ORIGINAL_GPG_HOME, subpath);
    const contents = await new Promise((resolve, reject) => {
      fs.readdir(dirPath, (err, readdirResult) => (err ? reject(err) : resolve(readdirResult)));
    });

    return Promise.all(contents.map(entry => copyGpgEntry(subpath, entry)));
  }

  return copyGpgDirectory('');
}

function startIsolatedAgent() {
  log(`Starting an isolated GPG agent in ${GPG_TMP_HOME}.`);

  return new Promise((resolve, reject) => {
    const args = [
      '--daemon',
      '--verbose',
      '--homedir', GPG_TMP_HOME,
      '--pinentry-program', pinentryLauncher,
    ];

    const env = {GNUPGHOME: GPG_TMP_HOME};
    const varsToPass = [
      'PATH', 'GIT_TRACE',
      'ATOM_GITHUB_TMP', 'ATOM_GITHUB_ELECTRON_PATH', 'ATOM_GITHUB_SOCK_PATH', 'ATOM_GITHUB_PINENTRY_PATH',
    ];
    for (let i = 0; i < varsToPass.length; i++) {
      env[varsToPass[i]] = process.env[varsToPass[i]];
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    const agentEnv = {
      GPG_AGENT_INFO: '',
    };

    // TODO ensure that the gpg-agent corresponds to the gpg binary
    // TODO allow explicit gpg-agent specification just in case
    log(`Spawning gpg-agent with ${args.join(' ')}`);
    const agent = spawn('gpg-agent', args, {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });

    agent.on('error', err => {
      log(`gpg-agent failed to launch: ${err}`);
      // TODO attempt 1.4.x mode here

      if (!done) {
        done = true;
        reject(err);
      }
    });

    agent.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        reject(new Error(`gpg-agent exited with status ${code}.`));
        return;
      } else if (signal !== null) {
        reject(new Error(`gpg-agent was terminated with signal ${signal}.`));
        return;
      } else {
        log('gpg-agent launched successfully.');
      }

      if (!done) {
        done = true;

        // Parse GPG_AGENT_INFO from stdout.
        const match = /GPG_AGENT_INFO=([^;\s]+)/.exec(stdout);
        if (match) {
          log(`Acquired agent info ${match[1]}.`);
          agentEnv.GPG_AGENT_INFO = match[1];
        }

        resolve(agentEnv);
      }
    });

    agent.stdout.setEncoding('utf8');
    agent.stdout.on('data', chunk => (stdout += chunk));

    agent.stderr.setEncoding('utf8');
    agent.stderr.on('data', chunk => (stderr += chunk));
  });
}

function runGpgProgram(gpgProgram, gpgHome, gpgStdin, agentEnv) {
  const gpgArgs = [
    '--batch', '--no-tty', '--yes', '--homedir', gpgHome,
  ].concat(process.argv.slice(2));

  log(`Executing ${gpgProgram} ${gpgArgs.join(' ')}.`);

  return new Promise((resolve, reject) => {
    const env = agentEnv;
    if (!env.PATH) { env.PATH = process.env.PATH; }
    if (!env.GPG_AGENT_INFO) { env.GPG_AGENT_INFO = process.env.GPG_AGENT_INFO || ''; }
    if (!env.GNUPGHOME) { env.GNUPGHOME = gpgHome; }

    let stdout = '';
    let stderr = '';
    let done = false;

    const gpg = spawn(gpgProgram, gpgArgs, {env});

    gpg.stderr.on('data', chunk => {
      log(chunk, true);
      stderr += chunk;
    });

    gpg.stdout.on('data', chunk => {
      log(chunk, true);
      stdout += chunk;
    });

    gpg.on('error', err => {
      if (!done) {
        reject(err);
        done = true;
      }
    });

    gpg.on('exit', (code, signal) => {
      let errorMessage = null;

      if (code !== 0 && code !== null) {
        errorMessage = `gpg process exited abnormally with code ${code}.`;
      } else if (signal !== null) {
        errorMessage = `gpg process terminated with signal ${signal}.`;
      }

      if (errorMessage && done) {
        log(errorMessage);
      } else if (errorMessage && !done) {
        const err = new Error(errorMessage);
        err.stderr = stderr;
        err.stdout = stdout;
        err.code = code;
        err.signal = signal;

        done = true;
        reject(err);
      } else if (!errorMessage && done) {
        log('gpg process terminated normally.');
      } else if (!errorMessage && !done) {
        // Success. Propagate stdout, stderr, and the exit status to the calling process.
        process.stderr.write(stderr);
        process.stdout.write(stdout);

        done = true;
        resolve(code);
      }
    });

    gpg.stdin.end(gpgStdin);
  });
}

/*
 * Emit diagnostic messages to stderr if GIT_TRACE is set to a non-empty value.
 */
function log(message, raw = false) {
  if (!diagnosticsEnabled) {
    return;
  }

  if (!logStream) {
    const logFile = path.join(process.env.ATOM_GITHUB_TMP, 'gpg-wrapper.log');
    logStream = fs.createWriteStream(logFile, {defaultEncoding: true});
  }

  if (!raw) {
    logStream.write(`gpg-wrapper: ${message}\n`);
  } else {
    logStream.write(message);
  }
}

async function cleanup() {
  if (logStream) {
    await new Promise(resolve => logStream.end('\n', 'utf8', resolve));
  }
}

main();