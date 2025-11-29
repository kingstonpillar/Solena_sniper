import fs from "fs";
import { jest } from "@jest/globals";

// -------------------- MOCKS --------------------
jest.unstable_mockModule("../autosell.js", () => ({
  executeAutoSell: jest.fn(),
}));

jest.unstable_mockModule("../sellmonitor.js", () => ({
  markSellStart: jest.fn(),
  markSellComplete: jest.fn(),
  allSellsComplete: jest.fn(() => true),
}));

jest.unstable_mockModule("../tokenCreatorScanner.js", () => ({
  verifyCreatorSafety: jest.fn(),
}));

jest.unstable_mockModule("@solana/web3.js", () => ({
  Connection: jest.fn().mockImplementation(() => ({
    getTokenLargestAccounts: jest.fn(),
    getParsedAccountInfo: jest.fn(),
  })),
  PublicKey: jest.fn().mockImplementation((x) => x),
}));

jest.unstable_mockModule("../liquidityGuard.js", () => {
  const real = jest.requireActual("../liquidityGuard.js");
  return {
    ...real,
    jupiterFetch: jest.fn(),
    detectBigSell: jest.fn(),
  };
});

// -------------------- IMPORT TARGET --------------------
const { monitorLiquidity } = await import("../liquidityGuard.js");
const { jupiterFetch, detectBigSell } = await import("../liquidityGuard.js");
const { verifyCreatorSafety } = await import("../tokenCreatorScanner.js");
const { executeAutoSell } = await import("../autosell.js");
const { Connection } = await import("@solana/web3.js");

// -------------------- FIXED POSITION --------------------
const mockPositions = [
  {
    mintAddress: "MockMint111",
    buyPrice: 1,
    symbol: "MOCK",
    amount: 10000,
  },
];

// -------------------- TEST SUITE --------------------
describe("LiquidityGuard Full Sell Logic Test Suite", () => {
  beforeAll(() => {
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(mockPositions));
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Default RPC mock — 100 liquidity
    Connection.mock.instances[0].getTokenLargestAccounts
      .mockResolvedValue({ value: [{ address: "LP1" }] });

    Connection.mock.instances[0].getParsedAccountInfo
      .mockResolvedValue({
        value: {
          data: {
            parsed: { info: { owner: "OwnerX", tokenAmount: { ui: 100 } } },
          },
        },
      });

    verifyCreatorSafety.mockResolvedValue({ safe: true });
    detectBigSell.mockResolvedValue(false);
  });

  // -------------------- A — Price Rug Sell --------------------
  test("A — triggers sell when price rugs", async () => {
    jupiterFetch.mockResolvedValue({
      MockMint111: { price: 0.2 }, // 80% drop
    });

    await monitorLiquidity();
    expect(executeAutoSell).toHaveBeenCalled();
  });

  // -------------------- B — LP Too Low Sell --------------------
  test("B — triggers sell when liquidity < 30", async () => {
    Connection.mock.instances[0].getParsedAccountInfo
      .mockResolvedValue({
        value: {
          data: { parsed: { info: { tokenAmount: { ui: 5 } } } },
        },
      });

    jupiterFetch.mockResolvedValue({
      MockMint111: { price: 1 }, // normal price
    });

    await monitorLiquidity();
    expect(executeAutoSell).toHaveBeenCalled();
  });

  // -------------------- C — Big Sell Pressure --------------------
  test("C — triggers sell when big sell pressure detected", async () => {
    detectBigSell.mockResolvedValue(true);

    jupiterFetch.mockResolvedValue({
      MockMint111: { price: 1 }, // normal price
    });

    await monitorLiquidity();
    expect(executeAutoSell).toHaveBeenCalled();
  });

  // -------------------- D — Creator unsafe triggers sell --------------------
  test("D — triggers sell when creator becomes unsafe", async () => {
    verifyCreatorSafety.mockResolvedValue({ safe: false });

    jupiterFetch.mockResolvedValue({
      MockMint111: { price: 1 },
    });

    await monitorLiquidity();
    expect(executeAutoSell).toHaveBeenCalled();
  });

  // -------------------- E — Profit 2× --------------------
  test("E — triggers sell on 2× profit", async () => {
    jupiterFetch.mockResolvedValue({
      MockMint111: { price: 2.1 }, // >2x
    });

    await monitorLiquidity();
    expect(executeAutoSell).toHaveBeenCalled();
  });

  // -------------------- F — Panic LP drop --------------------
  test("F — triggers sell when LP drops > 40% within 10s", async () => {
    // 1st run — LP = 100
    Connection.mock.instances[0].getParsedAccountInfo
      .mockResolvedValueOnce({
        value: {
          data: { parsed: { info: { tokenAmount: { ui: 100 } } } },
        },
      });

    jupiterFetch.mockResolvedValue({
      MockMint111: { price: 1 },
    });

    // Run once to initialize LP
    await monitorLiquidity();

    // 2nd run — LP = 50 (50% drop)
    Connection.mock.instances[0].getParsedAccountInfo
      .mockResolvedValueOnce({
        value: {
          data: { parsed: { info: { tokenAmount: { ui: 50 } } } },
        },
      });

    await monitorLiquidity();

    expect(executeAutoSell).toHaveBeenCalled();
  });

  // -------------------- G — No sell on stable token --------------------
  test("G — does NOT sell when everything is normal", async () => {
    jupiterFetch.mockResolvedValue({
      MockMint111: { price: 1 },
    });

    await monitorLiquidity();

    expect(executeAutoSell).not.toHaveBeenCalled();
  });
});