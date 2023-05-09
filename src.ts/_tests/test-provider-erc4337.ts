import assert from "assert";

import { Erc4337Provider, Erc4337WalletInfo, isError, UserOperation, UserOperationCalldata, Wallet } from '../index.js'

import type { TransactionResponse } from "../index.js";

function stall(duration: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, duration); });
}

const walletInfo: Erc4337WalletInfo = {
    encodeBatchCalldata (_: Array<UserOperationCalldata>): Promise<string> {
        return Promise.resolve('')
    }, encodeCalldata (_: UserOperationCalldata): Promise<string> {
        return Promise.resolve('')
    }, getAddress (): Promise<string> {
        return Promise.resolve('')
    }, getInitCode (): Promise<string> {
        return Promise.resolve('')
    }, getNonce (): Promise<string> {
        return Promise.resolve('')
    }, getPaymasterAndData (_: Partial<UserOperation>): Promise<string> {
        return Promise.resolve('')
    }, getSignatureForEstimateGas (): Promise<string> {
        return Promise.resolve('')
    }, signEip1271Message (_: string): Promise<string> {
        return Promise.resolve('')
    }, signUserOp (_: UserOperation): Promise<string> {
        return Promise.resolve('')
    }

}

describe("Sends UserOperation", function() {

    const wallet = new Wallet(<string>(process.env.FAUCET_PRIVATEKEY));

    // const networkName = "goerli";
    for (const providerName of ['one']) {
        // const provider = getProvider(providerName, networkName);
        const provider = new Erc4337Provider('', walletInfo)
        if (provider == null) { continue; }

        it(`tests sending: ${ providerName }`, async function() {
            this.timeout(180000);

            const w = wallet.connect(provider);

            const dustAddr = Wallet.createRandom().address;

            // Retry if another CI instance used our value
            let tx: null | TransactionResponse = null;
            for (let i = 0; i < 10; i++) {
                try {
                    tx = await w.sendTransaction({
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
