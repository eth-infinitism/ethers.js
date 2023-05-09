import {
  AbstractProvider,
  AbstractSigner,
  JsonRpcProvider,
  Networkish,
  Provider,
  Signer,
  TransactionRequest,
  TransactionResponse,
  TypedDataDomain,
  TypedDataEncoder,
  TypedDataField,
  assert,
  assertArgument,
  hashMessage,
  resolveAddress,
  toBigInt
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

export interface UserOperationGasEstimation {
  // gas overhead of this UserOperation
  preVerificationGas: bigint

  // actual gas used by the validation of this UserOperation
  verificationGasLimit: bigint

  // value used by inner account execution
  callGasLimit: bigint
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

/**
 * Connects to a {@link bundlerUrl} with a JsonRpcProvider
 */
export class Erc4337Provider extends AbstractProvider {
  jsonRpcProvider: JsonRpcProvider
  signer: Erc4337Signer

  supportedEntryPoints?: string[]

  constructor (
    readonly bundlerUrl: string,
    readonly walletInfo: Erc4337WalletInfo,
    _network?: 'any' | Networkish
  ) {
    super(_network)
    this.jsonRpcProvider = new JsonRpcProvider(bundlerUrl)
    this.signer = new Erc4337Signer(walletInfo, this)
  }

  async send (method: string, params: Array<any> | Record<string, any>): Promise<any> {
    // TODO: intercept direct sending of methods ERC-4337 overrides
    return this.jsonRpcProvider.send(method, params)
  }

  async getSigner (address?: number | string): Promise<Erc4337Signer> {
    if (address != null) {
      if (typeof address === 'number') {
        assert(address === 0, 'ERC-4337 Signer only controls one address', 'UNSUPPORTED_OPERATION', {
          operation: 'provider.getSigner'
        })
      } else {
        const signerAddress = await this.signer.getAddress()
        assert(signerAddress.toLowerCase() === address.toLowerCase(),
          'address mismatch', 'UNSUPPORTED_OPERATION')
      }
    }
    return this.signer
  }

  async estimateGas (_tx: TransactionRequest): Promise<bigint> {
    assert(false, 'cannot estimate ERC-4337 UserOp gas without signer', 'UNSUPPORTED_OPERATION', {
      operation: 'provider.estimateGas'
    })
  }

  private async verifyEntryPointSupported (entryPoint: string): Promise<void> {
    const supportedEntryPoints = await this.getSupportedEntryPoints()
    const supported = supportedEntryPoints.map(it => it.toLowerCase()).includes(entryPoint.toLowerCase())
    assert(supported, `the EntryPoint at ${entryPoint} is not supported by this bundler`, 'UNSUPPORTED_OPERATION', {
      operation: 'provider.verifyEntryPointSupported'
    })
  }

  // Modified ERC-4337 methods

  async estimateUserOperationGas (userOperation: UserOperation, _entryPoint?: string): Promise<UserOperationGasEstimation> {
    const supportedEntryPoints = await this.getSupportedEntryPoints()
    let entryPoint = _entryPoint
    if (entryPoint == null) {
      if (supportedEntryPoints.length !== 1) {
        assert(false, 'bundler supports multiple EntryPoints - must specify one to use', 'UNSUPPORTED_OPERATION', {
          operation: 'provider.estimateGas'
        })
      }
      entryPoint = this.supportedEntryPoints?.[0]
      assert(entryPoint != null, 'bundler reported no supported EntryPoints - use different bundler URL', 'UNSUPPORTED_OPERATION', {
        operation: 'provider.estimateGas'
      })
    }
    await this.verifyEntryPointSupported(entryPoint)
    return this.jsonRpcProvider.send('eth_estimateUserOperationGas', [userOperation, entryPoint])
  }

  async getSupportedEntryPoints (): Promise<string[]> {
    return this.jsonRpcProvider.send('eth_supportedEntryPoints', [])
  }

  async getUserOperation (userOpHash: string): Promise<any> {
    return this.jsonRpcProvider.send('eth_getUserOperationByHash', [userOpHash])
  }

  async getUserOperationReceipt (userOpHash: string): Promise<any> {
    return this.jsonRpcProvider.send('eth_getUserOperationReceipt', [userOpHash])
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

  /**
   * Note: this function may be counter-intuitive as it drop the verification gas info from the returned value.
   * It may be useful if the app needs an inner call gas limit estimation. TBD if this needs to be removed.
   */
  async estimateGas (tx: TransactionRequest): Promise<bigint> {
    const address = await this.getAddress()

    const _from = tx.from
    if (_from != null) {
      const from = await resolveAddress(_from)
      assertArgument(from.toLowerCase() === address.toLowerCase(),
        'transaction from mismatch', 'tx.from', from)
    }
    const userOperation = await this.populateUserOperation(tx)
    const userOperationGasEstimation = await this.provider.estimateUserOperationGas(userOperation)
    return userOperationGasEstimation.callGasLimit
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

  /**
   * This function returns a 'signed transaction' that can be passed to 'eth_sendRawTransaction' RPC endpoint.
   * There is no meaningful 'signed transaction' equivalent in ERC-4337.
   */
  async signTransaction (tx: TransactionRequest): Promise<string> {
    assert(false, 'cannot sign regular transaction with an Erc4337Signer', 'UNSUPPORTED_OPERATION', {
      operation: 'signer.signTransaction'
    })
  }

  async sendTransaction (tx: TransactionRequest): Promise<TransactionResponse> {
    const userOperation = await this.populateUserOperation(tx)
    userOperation.signature = await this.signUserOperation(userOperation)
    return this.sendUserOperation(userOperation)
  }

  async sendUserOperation (userOperation: UserOperation): Promise<TransactionResponse> {
    assert(userOperation.signature != null, 'passed UserOperation is not signed', 'UNSUPPORTED_OPERATION', {
      operation: 'signer.sendUserOperation'
    })
    return this.provider.send('eth_sendUserOperation', userOperation)
  }

  async signUserOperation (userOperation: UserOperation): Promise<string> {
    assert(userOperation.signature == null, 'passed UserOperation already signed', 'UNSUPPORTED_OPERATION', {
      operation: 'signer.signUserOperation'
    })
    return await this.walletInfo.signUserOp(userOperation)
  }

  // copied from 'base-wallet.ts' with signature delegated to the 'WalletInfo'
  signMessage (message: string | Uint8Array): Promise<string> {
    return this.walletInfo.signEip1271Message(hashMessage(message))
  }

  async signTypedData (domain: TypedDataDomain, types: Record<string, Array<TypedDataField>>, value: Record<string, any>): Promise<string> {
    const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (name: string) => {
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
