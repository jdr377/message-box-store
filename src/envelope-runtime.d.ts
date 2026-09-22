export const MESSAGEBOX_PROTOCOL: readonly [1, 'messagebox']
export const MESSAGEBOX_KEY_ID: '1'

export interface MessageBoxEncryptWallet {
  encrypt(args: {
    protocolID: [number, string]
    keyID: string
    counterparty: string
    plaintext: number[]
  }): Promise<{ ciphertext: ArrayLike<number> }>
}

export interface MessageBoxDecryptWallet {
  decrypt(args: {
    protocolID: [number, string]
    keyID: string
    counterparty: string
    ciphertext: number[]
  }): Promise<{ plaintext: ArrayLike<number> }>
}

export interface PreparedEncryptedBody {
  body: string
  plaintext: string
  ciphertext: number[]
  encryptedMessage: string
}

export function plaintextText(value: string | Record<string, unknown>): string
export function prepareEncryptedBody(args: {
  wallet: MessageBoxEncryptWallet
  plaintext: string | Record<string, unknown>
  counterparty: string
}): Promise<PreparedEncryptedBody>
export function extractEncryptedMessage(
  body: string | Record<string, unknown>,
  options?: { allowPaymentFreeTransportWrapper?: boolean },
): string
export function decryptArchivedBody(args: {
  wallet: MessageBoxDecryptWallet
  body: string | Record<string, unknown>
  counterparty: string
  allowPaymentFreeTransportWrapper?: boolean
}): Promise<string>
export function bodyHash(body: string): string
export function canonicalRecordKey(args: {
  ownerIdentityKey: string
  direction: 'inbound' | 'outbound'
  messageBox: string
  sender: string
  recipient: string
  messageId: string
}): string
