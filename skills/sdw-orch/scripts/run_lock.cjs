'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// AC9-AC11 (spec 00019): one exclusive lock per run state file. The lock is a
// sibling file created with the exclusive-create flag, so two processes cannot
// both hold it. A live lock blocks mutation; an abandoned one is reclaimed only
// after lockStaleMs and only when the recorded owner process is proven absent.
const DEFAULT_STALE_MS = 300000;
const RUN_LOCKED_CODE = 'RUN_LOCKED';

class RunLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunLockError';
    this.code = RUN_LOCKED_CODE;
  }
}

function isRunLockError(err) {
  return Boolean(err) && err.code === RUN_LOCKED_CODE;
}

// The lock is a sibling of the state file: one lock per run state file.
function lockFileFor(stateFilePath) {
  return `${stateFilePath}.lock`;
}

function readLockFile(lockFile) {
  let raw;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch (err) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === 'EPERM';
  }
}

// 'wx' is the atomic exclusive create: it fails with EEXIST when another
// process already holds the lock, on every supported platform.
function writeLockFile(lockFile, lock) {
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch (e) {
      // Best-effort durability only.
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function lockAgeMs(lock, lockFile) {
  const acquiredAtMs = Date.parse(lock.acquiredAt);
  if (!Number.isNaN(acquiredAtMs)) return Math.max(0, Date.now() - acquiredAtMs);
  try {
    return Math.max(0, Date.now() - fs.statSync(lockFile).mtimeMs);
  } catch (err) {
    return 0;
  }
}

function isLockRecord(lock) {
  return Boolean(lock)
    && Number.isInteger(lock.pid)
    && lock.pid > 0
    && typeof lock.host === 'string'
    && lock.host.length > 0
    && typeof lock.acquiredAt === 'string';
}

function ownerLabel(lock) {
  return `pid ${lock.pid} on host ${lock.host} (acquired ${lock.acquiredAt})`;
}

function displayPath(lockFile) {
  return lockFile.replace(/\\/g, '/');
}

// AC10: every refusal names the owner and the exact remediation, so the operator
// can tell contention apart from a crashed run and act without reading the code.
function contentionMessage(lockFile, lock, staleMs, reason) {
  const prefix = `Run lock "${displayPath(lockFile)}" is held by ${ownerLabel(lock)}.`;
  if (reason === 'foreign-host') {
    return `${prefix} The lock was acquired on another host, so its owner cannot be verified here. Delete the lock file manually only if you are sure no process is using this run.`;
  }
  if (reason === 'stale-owner-alive') {
    return `${prefix} The lock is older than lockStaleMs=${staleMs} ms, but the owner process is still alive, so it cannot be reclaimed. Wait for it to finish, or stop it and delete the lock file manually.`;
  }
  if (reason === 'young-owner-absent') {
    return `${prefix} The owner process is not running, but the lock is younger than lockStaleMs=${staleMs} ms, so it was not reclaimed yet. Wait for it to expire, or delete the lock file manually if you are sure no other process is using this run.`;
  }
  return `${prefix} Another sdw-orch process is mutating this run state. Wait for that process to finish, or delete the lock file manually if you are sure it is gone.`;
}

function unreadableMessage(lockFile) {
  return `Run lock "${displayPath(lockFile)}" exists but does not contain a readable pid, host, and acquiredAt record. Another process may be acquiring it. If no other process is using this run, delete the lock file manually and retry.`;
}

// The unlink/recreate window is serialized through a guard file: two processes
// that both observed the same stale record cannot both reclaim it. The loser
// re-reads under the guard, finds a record that is not the one it decided to
// reclaim, and reports contention instead of deleting the winner's lock.
function reclaim(lockFile, expected, lock, staleMs) {
  const guardFile = `${lockFile}.reclaim`;
  let guardFd = null;
  try {
    guardFd = fs.openSync(guardFile, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // A guard left by a crash is only reclaimed after the same staleness bound.
    let guardAgeMs = Number.POSITIVE_INFINITY;
    try {
      guardAgeMs = Math.max(0, Date.now() - fs.statSync(guardFile).mtimeMs);
    } catch (e) {
      if (e.code !== 'ENOENT') throw err;
    }
    if (guardAgeMs >= staleMs) {
      try {
        fs.unlinkSync(guardFile);
      } catch (e) {}
      try {
        guardFd = fs.openSync(guardFile, 'wx');
      } catch (e) {}
    }
    if (guardFd === null) {
      throw new RunLockError(expected === null
        ? unreadableMessage(lockFile)
        : contentionMessage(lockFile, expected, staleMs, 'live'));
    }
  }

  try {
    const verified = readLockFile(lockFile);
    const sameRecord = isLockRecord(verified) && isLockRecord(expected)
      && verified.pid === expected.pid
      && verified.host === expected.host
      && verified.acquiredAt === expected.acquiredAt;
    const stillUnreadable = expected === null && !isLockRecord(verified);
    if (!sameRecord && !stillUnreadable) {
      if (isLockRecord(verified)) throw new RunLockError(contentionMessage(lockFile, verified, staleMs, 'live'));
      throw new RunLockError(unreadableMessage(lockFile));
    }
    try {
      fs.unlinkSync(lockFile);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new RunLockError(unreadableMessage(lockFile));
    }
    if (writeLockFile(lockFile, lock)) {
      return { lockFile, lock, reclaimed: true };
    }
    const winner = readLockFile(lockFile);
    if (!isLockRecord(winner)) throw new RunLockError(unreadableMessage(lockFile));
    throw new RunLockError(contentionMessage(lockFile, winner, staleMs, 'live'));
  } finally {
    if (guardFd !== null) {
      try {
        fs.closeSync(guardFd);
      } catch (e) {}
    }
    try {
      fs.unlinkSync(guardFile);
    } catch (e) {}
  }
}

// AC9: acquire before mutation. Returns a handle the caller must release.
function acquire(stateFilePath, options = {}) {
  const lockFile = lockFileFor(stateFilePath);
  const staleMs = Number.isInteger(options.staleMs) && options.staleMs > 0
    ? options.staleMs
    : DEFAULT_STALE_MS;
  const lock = {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString()
  };

  if (writeLockFile(lockFile, lock)) {
    return { lockFile, lock, reclaimed: false };
  }

  const existing = readLockFile(lockFile);
  if (!isLockRecord(existing)) {
    // A crash between creating the lock file and writing its record leaves an
    // unreadable lock with no owner to prove absent. Its age is the only
    // evidence: an old one is reclaimed, a young one is refused.
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Math.max(0, Date.now() - fs.statSync(lockFile).mtimeMs);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new RunLockError(unreadableMessage(lockFile));
    }
    if (ageMs < staleMs) {
      throw new RunLockError(unreadableMessage(lockFile));
    }
    return reclaim(lockFile, null, lock, staleMs);
  }

  const stale = lockAgeMs(existing, lockFile) >= staleMs;
  const sameHost = existing.host === os.hostname();
  const ownerAlive = sameHost ? isProcessAlive(existing.pid) : null;

  // Reclaim only when both conditions hold: the record is older than the
  // threshold and the owner is proven absent.
  if (stale && sameHost && ownerAlive === false) {
    return reclaim(lockFile, existing, lock, staleMs);
  }

  if (!sameHost) throw new RunLockError(contentionMessage(lockFile, existing, staleMs, 'foreign-host'));
  if (stale) throw new RunLockError(contentionMessage(lockFile, existing, staleMs, 'stale-owner-alive'));
  if (!ownerAlive) throw new RunLockError(contentionMessage(lockFile, existing, staleMs, 'young-owner-absent'));
  throw new RunLockError(contentionMessage(lockFile, existing, staleMs, 'live'));
}

// Release only the record this process acquired: a reclaimed lock belongs to a
// different owner and must never be deleted by the previous holder.
function release(handle) {
  if (!handle || handle.released) return false;
  handle.released = true;
  const current = readLockFile(handle.lockFile);
  if (!current
    || current.pid !== handle.lock.pid
    || current.host !== handle.lock.host
    || current.acquiredAt !== handle.lock.acquiredAt) {
    return false;
  }
  try {
    fs.unlinkSync(handle.lockFile);
    return true;
  } catch (err) {
    return false;
  }
}

// Reentrancy: a mutating helper that calls saveRunState must not deadlock on its
// own lock. The outermost synchronous callback owns the file lock and releases
// it in a finally, so a thrown error never leaves the run locked.
const heldLocks = new Map();

function withLock(stateFilePath, fn, options = {}) {
  const lockFile = path.resolve(lockFileFor(stateFilePath));
  const current = heldLocks.get(lockFile);
  if (current) {
    current.depth += 1;
    try {
      return fn();
    } finally {
      current.depth -= 1;
      if (current.depth === 0) {
        heldLocks.delete(lockFile);
        release(current.handle);
      }
    }
  }

  const handle = acquire(stateFilePath, options);
  const entry = { handle, depth: 1 };
  heldLocks.set(lockFile, entry);
  try {
    return fn();
  } finally {
    entry.depth -= 1;
    if (entry.depth === 0) {
      heldLocks.delete(lockFile);
      release(handle);
    }
  }
}

module.exports = {
  DEFAULT_STALE_MS,
  RUN_LOCKED_CODE,
  RunLockError,
  isRunLockError,
  lockFileFor,
  isProcessAlive,
  acquire,
  release,
  withLock
};
