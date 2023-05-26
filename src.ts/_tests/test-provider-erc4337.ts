import assert from "assert";

import {
  Contract,
  ContractRunner,
  Erc4337Provider,
  Erc4337WalletInfo,
  JsonRpcProvider,
  UserOperation,
  UserOperationCalldata,
  Wallet,
  isError
} from '../index.js'

import type { TransactionResponse } from "../index.js";
import { hexToBytes } from '@noble/hashes/utils'

function stall(duration: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, duration); });
}

const executeMethodAbi = {
  inputs: [
    {
      internalType: "address",
      name: "dest",
      type: "address"
    },
    {
      internalType: "uint256",
      name: "value",
      type: "uint256"
    },
    {
      internalType: "bytes",
      name: "func",
      type: "bytes"
    }
  ],
  name: "execute",
  outputs: [],
  stateMutability: "nonpayable",
  type: "function"
}

const executeBatchMethodAbi = {
  inputs: [
    {
      internalType: "address[]",
      name: "dest",
      type: "address[]"
    },
    {
      internalType: "bytes[]",
      name: "func",
      type: "bytes[]"
    }
  ],
  name: "executeBatch",
  outputs: [],
  stateMutability: "nonpayable",
  type: "function"
}

const getNonceAbi = {
  inputs: [
    {
      internalType: "address",
      name: "sender",
      type: "address"
    },
    {
      internalType: "uint192",
      name: "key",
      type: "uint192"
    }
  ],
  "name": "getNonce",
  "outputs": [
    {
      internalType: "uint256",
      name: "nonce",
      type: "uint256"
    }
  ],
  stateMutability: "view",
  type: "function"
}

const getUserOpHashAbi = {
  "inputs": [
    {
      "components": [
        {
          "internalType": "address",
          "name": "sender",
          "type": "address"
        },
        {
          "internalType": "uint256",
          "name": "nonce",
          "type": "uint256"
        },
        {
          "internalType": "bytes",
          "name": "initCode",
          "type": "bytes"
        },
        {
          "internalType": "bytes",
          "name": "callData",
          "type": "bytes"
        },
        {
          "internalType": "uint256",
          "name": "callGasLimit",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "verificationGasLimit",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "preVerificationGas",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "maxFeePerGas",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "maxPriorityFeePerGas",
          "type": "uint256"
        },
        {
          "internalType": "bytes",
          "name": "paymasterAndData",
          "type": "bytes"
        },
        {
          "internalType": "bytes",
          "name": "signature",
          "type": "bytes"
        }
      ],
      "internalType": "struct UserOperation",
      "name": "userOp",
      "type": "tuple"
    }
  ],
    "name": "getUserOpHash",
    "outputs": [
    {
      "internalType": "bytes32",
      "name": "",
      "type": "bytes32"
    }
  ],
    "stateMutability": "view",
    "type": "function"
}

const MUMBAI_SIMPLE_ACCOUNT = '0x0F48612d2517e47D72fEc92a2fc6fd64cA6816E0'
const MUMBAI_ENTRY_POINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'

class SampleWalletInfo implements Erc4337WalletInfo {
    entryPoint: Contract
    sampleWallet: Contract

    constructor (contractRunner: ContractRunner) {
      this.sampleWallet = new Contract(MUMBAI_SIMPLE_ACCOUNT, [executeMethodAbi, executeBatchMethodAbi], contractRunner)
      this.entryPoint = new Contract(MUMBAI_ENTRY_POINT, [getUserOpHashAbi, getNonceAbi], contractRunner)
    }

    encodeCalldata ({to, value, data}: UserOperationCalldata): Promise<string> {
      return Promise.resolve(this.sampleWallet.interface.encodeFunctionData('execute', [to, value ?? 0, data ?? '0x']))
    }

    encodeBatchCalldata (userOperationCalldata: Array<UserOperationCalldata>): Promise<string> {
      const to = userOperationCalldata.map(it => it.to)
      const value = userOperationCalldata.map(it => it.value)
      const data = userOperationCalldata.map(it => it.data)
      return Promise.resolve(this.sampleWallet.interface.encodeFunctionData('executeBatch', [to, value, data]))
    }

    getAddress (): Promise<string> {
        return Promise.resolve(MUMBAI_SIMPLE_ACCOUNT)
    }

    getInitCode (): Promise<string> {
        return Promise.resolve('0x')
    }

    async getNonce (): Promise<bigint> {
        const address = await this.getAddress()
        return this.entryPoint.getNonce(address, 0)
    }

    getPaymasterAndData (_: Partial<UserOperation>): Promise<string> {
        return Promise.resolve('0x')
    }

    async signUserOp (userOperation: UserOperation): Promise<string> {
        const wallet = new Wallet(process.env.OWNER_PRIVATE_KEY!)
        const address = await wallet.getAddress()
        console.log('address', address)
        const userOpCopy = Object.assign({}, userOperation, { signature: '0x' })
        const userOpHash = await this.entryPoint.getUserOpHash(userOpCopy)
        console.log('userOpHash', userOpHash)
        return wallet.signMessage(hexToBytes(userOpHash.replace('0x', '')))
    }

    signEip1271Message (_: string): Promise<string> {
        return Promise.resolve('0x')
    }

    getSignatureForEstimateGas (_: UserOperation): Promise<string> {
        return this.signUserOp(_)
    }

    getPaymasterAndDataForEstimateGas (_: Partial<UserOperation>): Promise<string> {
        return Promise.resolve('0x')
    }
}

describe("Sends UserOperation", function() {

    // const wallet = new Wallet(<string>(process.env.FAUCET_PRIVATEKEY));

    // const networkName = "goerli";
    for (const providerName of ['one']) {
        // const provider = getProvider(providerName, networkName);
        const contractRunner = new JsonRpcProvider('http://localhost:8545')
        // const contractRunner = new JsonRpcProvider('https://rpc-mumbai.maticvigil.com')
        const walletInfo = new SampleWalletInfo(contractRunner)
        const provider = new Erc4337Provider(
          'http://localhost:8545',
          'http://localhost:3000/rpc',
          '',
          walletInfo
        )
        // const provider = new Erc4337Provider('https://api.stackup.sh/v1/node/99a0e25254fab0ddf2c0b37c2e92fc41b2442d3ba77e1c6bb6b4fd998943baf9', walletInfo)
        if (provider == null) { continue; }

        it(`tests sending: ${ providerName }`, async function() {
            this.timeout(180000);

            // const w = wallet.connect(provider);
            const signer = await provider.getSigner()

            const dustAddr = Wallet.createRandom().address;

            // Retry if another CI instance used our value
            let tx: null | TransactionResponse = null;
            for (let i = 0; i < 10; i++) {
                try {
                    tx = await signer.sendTransaction({
                        to: dustAddr,
                        value: 42,
                        type: 2
                    });
                    break;
                } catch (error) {
                    if (isError(error, "REPLACEMENT_UNDERPRICED") || isError(error, "NONCE_EXPIRED")) {
                        await stall(1000);
                        continue;
                    }
                    throw error;
                }
            }
            assert.ok(!!tx, "too many retries");

            //const receipt =
            await provider.waitForTransaction(tx.hash, null, 60000); //tx.wait();
            //console.log(receipt);

            const balance = await provider.getBalance(dustAddr);
            assert.equal(balance, BigInt(42), "target balance after send");
        });
    }


});
