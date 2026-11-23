/**
 * Minimal Electron stand-in so the skills service can run under node:test.
 * Only what the skills/settings import chain touches is implemented.
 */
const { join } = require('node:path')
const { tmpdir, homedir } = require('node:os')

module.exports = {
  app: {
    getPath(name) {
      if (name === 'userData') return process.env.FCC_TEST_USERDATA || join(tmpdir(), 'fcc-test-user')
      if (name === 'home') return homedir()
      return tmpdir()
    },
    getVersion: () => '0.0.0-test',
    once: () => {},
    on: () => {},
    whenReady: () => Promise.resolve(),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}
