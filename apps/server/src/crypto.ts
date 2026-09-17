import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const VERSION = 'v1'

export class SecretVault {
  private constructor(private readonly key: Buffer) {}

  static async open(dataDir: string): Promise<SecretVault> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const keyPath = path.join(dataDir, 'master.key')
    let key: Buffer
    try {
      key = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64url')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      key = randomBytes(32)
      await writeFile(keyPath, key.toString('base64url'), { mode: 0o600, flag: 'wx' })
    }
    if (key.byteLength !== 32) throw new Error('Invalid CodyBotHub master key')
    await chmod(keyPath, 0o600)
    return new SecretVault(key)
  }

  encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
  }

  decrypt(value: string): string {
    const [version, ivValue, tagValue, encryptedValue] = value.split('.')
    if (version !== VERSION || !ivValue || !tagValue || encryptedValue === undefined) throw new Error('Invalid encrypted value')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
  }
}
