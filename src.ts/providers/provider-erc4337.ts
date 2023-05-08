import {
  AbstractProvider,
  AbstractSigner,
  Networkish,
  Provider,
  Signer,
  TransactionRequest,
  TypedDataDomain,
  TypedDataField,
  assert, resolveAddress, TransactionResponse, toBigInt, TypedDataEncoder, hashMessage, assertArgument
} from '../ethers'

export interface UserOperation {
  sender: string
  nonce: string
  initCode: string
  callData: string
  callGasLimit: bigint
  verificationGasLimit: string
  preVerificationGas: string
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint

  signature?: string
  paymasterAndData?: string
}

type UserOpCalldata = {
  to: string
  data?: string | null
  value?: string | null
}

/**
 *
 */
export interface Erc4337WalletInfo {
  // as defined by drortirosh
  getAddress: () => Promise<string>
  getInitCode: () => Promise<string>
  getNonce: () => Promise<string>
  encodeCalldata: (_: UserOpCalldata) => Promise<string>
  encodeBatchCalldata: (_: Array<UserOpCalldata>) => Promise<string>
  getSignatureForEstimateGas: () => Promise<string>
  signUserOp: (_: UserOperation) => Promise<string>

  // alexf - additions

  // if not supported - throw exception
  signEip1271Message: (_: string) => Promise<string>
  // the wallet decides if the fields passed into the callback are sufficient; if no - throw exception
  getPaymasterAndData: (_: Partial<UserOperation>) => Promise<string>

  getPreVerificationGas: () => Promise<string>
  getVerificationGasLimit: () => Promise<string>
}

export class Erc4337Provider extends AbstractProvider {
  signer: Erc4337Signer

  constructor (
    readonly origProvider: Provider,
    readonly walletInfo: Erc4337WalletInfo,
    _network?: 'any' | Networkish
  ) {
    super(_network)
    this.signer = new Erc4337Signer(walletInfo, this)
  }

  async getSigner (address?: number | string): Promise<Erc4337Signer> {
    // todo: check this address is controlled by the signer
    return this.signer
  }

  async estimateGas (_tx: TransactionRequest): Promise<bigint> {
    return super.estimateGas(_tx)
  }
}

export class Erc4337Signer extends AbstractSigner<Erc4337Provider> {
  isCodeDeployed?: boolean

  constructor (
    readonly walletInfo: Erc4337WalletInfo,
    provider: Erc4337Provider
  ) {
    super(provider)
  }

  connect (provider: Provider | null): Signer {
    assert(false, 'cannot reconnect Erc4337Signer', 'UNSUPPORTED_OPERATION', {
      operation: 'signer.connect'
    })
  }

  getAddress (): Promise<string> {
    return this.walletInfo.getAddress()
  }

  async encodeCalldata (tx: TransactionRequest): Promise<string> {
    const _to = tx.to
    if (_to == null) {
      throw new Error('no to')
    }
    const to = await resolveAddress(_to, this.provider)
    const data = tx.data
    const value = tx.value?.toString()
    return this.walletInfo.encodeCalldata({ to, data, value })
  }

  async estimateGas (tx: TransactionRequest): Promise<bigint> {
    const address = await this.getAddress()

    const _from = tx.from
    if (_from != null) {
      const from = await resolveAddress(_from)
      assertArgument(from.toLowerCase() === address.toLowerCase(),
        'transaction from mismatch', 'tx.from', from)
    }
    return super.estimateGas(Object.assign({}, tx, { from: address }))
  }

  async getInitCode () {
    if (this.isCodeDeployed) {
      return ''
    } else {
      return this.walletInfo.getInitCode()
    }
  }

  async getErc4337Nonce (): Promise<string> {
    return await this.walletInfo.getNonce()
  }

  async getPaymasterAndData (userOperation: UserOperation): Promise<string> {
    return this.walletInfo.getPaymasterAndData(userOperation)
  }

  async getPreVerificationGas (): Promise<string> {
    return this.walletInfo.getPreVerificationGas()
  }

  async getVerificationGasLimit (): Promise<string> {
    return this.walletInfo.getVerificationGasLimit()
  }

  async populateUserOperation (tx: TransactionRequest): Promise<UserOperation> {
    const callData = await this.encodeCalldata(tx)
    const callGasLimit = await this.estimateGas(tx)
    const initCode = await this.getInitCode()
    const nonce = await this.getErc4337Nonce()
    const preVerificationGas = await this.getPreVerificationGas()
    const sender = await this.getAddress()
    const verificationGasLimit = await this.getVerificationGasLimit()

    let maxFeePerGas: bigint
    let maxPriorityFeePerGas: bigint
    if (tx.maxFeePerGas != null && tx.maxPriorityFeePerGas != null) {
      maxFeePerGas = toBigInt(tx.maxFeePerGas)
      maxPriorityFeePerGas = toBigInt(tx.maxPriorityFeePerGas)
    } else if (tx.gasPrice != null) {
      maxFeePerGas = toBigInt(tx.gasPrice)
      maxPriorityFeePerGas = toBigInt(tx.gasPrice)
    } else {
      const feeData = await this.provider.getFeeData()
      maxFeePerGas = feeData.maxFeePerGas!
      maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!
    }

    const userOperation: UserOperation = {
      callData,
      callGasLimit,
      initCode,
      nonce,
      preVerificationGas,
      sender,
      verificationGasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas
    }

    userOperation.paymasterAndData = await this.getPaymasterAndData(userOperation)
    return userOperation
  }

  async signTransaction (tx: TransactionRequest): Promise<string> {
    const userOperation = await this.populateUserOperation(tx)
    return await this.walletInfo.signUserOp(userOperation)
  }

  async sendTransaction (tx: TransactionRequest): Promise<TransactionResponse> {
    return super.sendTransaction(tx)
  }

  // copied from 'base-wallet.ts' with signature delegated to the 'WalletInfo'
  signMessage (message: string | Uint8Array): Promise<string> {
    return this.walletInfo.signEip1271Message(hashMessage(message))
  }

  async signTypedData (domain: TypedDataDomain, types: Record<string, Array<TypedDataField>>, value: Record<string, any>): Promise<string> {
    // Populate any ENS names
    const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (name: string) => {
      // @TODO: this should use resolveName; addresses don't
      //        need a provider

      assert(this.provider != null, 'cannot resolve ENS names without a provider', 'UNSUPPORTED_OPERATION', {
        operation: 'resolveName',
        info: { name }
      })

      const address = await this.provider.resolveName(name)
      assert(address != null, 'unconfigured ENS name', 'UNCONFIGURED_NAME', {
        value: name
      })

      return address
    })

    return this.walletInfo.signEip1271Message(TypedDataEncoder.hash(populated.domain, types, populated.value))
  }

}
