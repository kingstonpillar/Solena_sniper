import { Connection, Keypair } from "@solana/web3.js";
import { buildSwapTx } from "./pool_registry.js";

const RPC = "https://api.mainnet-beta.solana.com";  // or your RPC
const conn = new Connection(RPC, "confirmed");

// Fake wallet for testing (DO NOT USE REAL WALLET HERE)
const fakeWallet = Keypair.generate();

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TEST_TOKEN = "Es9vMFrzaCERhCj5dS9Nq2VbBGqvkUbjCHc7Gyb8YkqC"; // USDT

(async () => {
    try {
        const { instructions, signers } = await buildSwapTx(
            conn,
            fakeWallet,
            SOL_MINT,
            TEST_TOKEN,
            10000000n // 0.01 SOL
        );

        console.log("Swap instructions built successfully:");
        console.log("Instruction count:", instructions.length);
        console.log("Signers count:", signers.length);
        console.log("Builder works ✔");

    } catch (err) {
        console.error("Builder failed ❌");
        console.error(err);
    }
})();