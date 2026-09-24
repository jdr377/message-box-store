import {
  MessageBoxStoreClient,
  decryptArchivedBody,
  syncHistory,
} from '@jdr377/message-box-store'
import type {
  HistoryRecord,
  LocalReplica,
  MessageBoxDecryptWallet,
  SyncHistoryResult,
  WalletInterface,
} from '@jdr377/message-box-store'

export interface PrivateHistoryOptions {
  walletClient: WalletInterface
  historyHost: string
  localReplica: LocalReplica
}

/** Synchronize encrypted history for the identity owned by this wallet. */
export async function syncPrivateHistory(
  options: PrivateHistoryOptions,
): Promise<SyncHistoryResult> {
  const identity = await options.walletClient.getPublicKey({ identityKey: true })
  const historyClient = new MessageBoxStoreClient({
    walletClient: options.walletClient,
    host: options.historyHost,
  })

  return syncHistory({
    owner: identity.publicKey,
    historyClient,
    localReplica: options.localReplica,
  })
}

/** Decrypt one cached record without sending its ciphertext to the service. */
export function decryptPrivateHistoryRecord(
  walletClient: MessageBoxDecryptWallet,
  record: HistoryRecord,
): Promise<string> {
  const counterparty = record.direction === 'inbound'
    ? record.sender
    : record.recipient

  return decryptArchivedBody({
    wallet: walletClient,
    body: record.body,
    counterparty,
  })
}
