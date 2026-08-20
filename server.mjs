// Cloud dry-run watcher: watches top USDC-loan markets on Base, notifies on opportunities.
// Never sends transactions. Exposes /health for UptimeRobot. Telegram via direct fetch (no proxy needed on cloud).
import http from "node:http";
import { createPublicClient, http as viemHttp, parseAbi } from "viem";
import { base } from "viem/chains";

const RPC = process.env.RPC_URL || "https://base-rpc.publicnode.com";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const API = "https://blue-api.morpho.org/graphql";
const POLL_MS = 6000;

const client = createPublicClient({ chain: base, transport: viemHttp(RPC) });
const morphoAbi = parseAbi([
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

async function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch {}
}

async function gql(q) {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
  const j = await res.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j;
}

const stats = { startedAt: Date.now(), cycles: 0, priceChanges: 0, alerts: 0 };
let healthHits = 0;
let markets = [];
let borrowers = new Map();
const alerted = new Set();
const lastPrice = new Map();

async function fetchMarketsAndBorrowers() {
  const q = "{ markets(where: { chainId_in: [8453] }, orderBy: BorrowAssetsUsd, orderDirection: Desc, first: 60) { items { marketId lltv oracle { address } loanAsset { symbol } collateralAsset { symbol address } state { borrowAssetsUsd } } } }";
  const j = await gql(q);
  markets = j.data.markets.items
    .filter((m) => m.loanAsset.symbol === "USDC" && Number(m.state.borrowAssetsUsd) >= 5e5)
    .slice(0, 26)
    .map((m) => ({ id: m.marketId, pair: m.collateralAsset.symbol + "/USDC", oracle: m.oracle.address, lltv: BigInt(m.lltv), coll: m.collateralAsset.address }));
  for (const m of markets) {
    try {
      const pq = "{ marketPositions(where: { chainId_in: [8453], marketUniqueKey_in: [\"" + m.id + "\"] }, first: 500) { items { user { address } state { borrowShares } } } }";
      const pj = await gql(pq);
      borrowers.set(m.id, pj.data.marketPositions.items.filter((it) => BigInt(it.state.borrowShares) > 0n).map((it) => it.user.address));
    } catch {}
  }
}

async function quoteSwap(tokenIn, tokenOut, amountIn) {
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const q = await client.readContract({
        address: QUOTER,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96: 0n }],
      });
      return { amountOut: q.amountOut, fee };
    } catch {}
  }
  return null;
}

async function cycle() {
  const blk = await client.getBlockNumber();
  for (const m of markets) {
    try {
      const price = await client.readContract({ address: m.oracle, abi: morphoAbi, functionName: "price" });
      if (lastPrice.has(m.id) && lastPrice.get(m.id) !== price) stats.priceChanges++;
      lastPrice.set(m.id, price);
      const mk = await client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m.id] });
      const totalBorrowAssets = BigInt(mk[2]);
      const totalBorrowShares = BigInt(mk[3]);
      if (totalBorrowShares === 0n) continue;
      for (const b of borrowers.get(m.id) || []) {
        try {
          const pos = await client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m.id, b] });
          const borrowShares = BigInt(pos[1]);
          const collateral = BigInt(pos[2]);
          if (borrowShares === 0n) continue;
          const borrowAssets = (borrowShares * totalBorrowAssets) / totalBorrowShares;
          const lhs = (collateral * price) / 10n ** 42n;
          const rhs = (borrowAssets * 10n ** 18n) / m.lltv;
          if (lhs >= rhs) continue;
          const key = m.id + "|" + b;
          if (alerted.has(key)) continue;
          alerted.add(key);
          stats.alerts++;
          const health = Number((lhs * 100n) / rhs);
          const repaidEst = borrowAssets;
          const flashPremium = (repaidEst * 5n) / 10000n;
          let profit = (repaidEst * (10n ** 18n - m.lltv)) / m.lltv - flashPremium;
          let sellPart = "";
          const q = await quoteSwap(m.coll, USDC, collateral);
          if (q) {
            profit = q.amountOut - repaidEst - flashPremium;
            sellPart = "卖出估价 $" + (Number(q.amountOut) / 1e6).toFixed(2) + " (fee " + q.fee + ") | ";
          }
          const profitUsd = (Number(profit) / 1e6).toFixed(2);
          const repayUsd = (Number(repaidEst) / 1e6).toFixed(2);
          tg("[机会] " + m.pair + " 健康度 " + health + "%\n借款人 " + b.slice(0, 10) + "\n" + sellPart + "还债 $" + repayUsd + " | 预期净利 $" + profitUsd + (profit > 0n ? " ✅可出手" : " ❌不划算") + "\n块高 " + blk);
        } catch {}
      }
    } catch {}
  }
  stats.cycles++;
}

const server = http.createServer((req, res) => {
  healthHits++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, uptimeMin: Math.round((Date.now() - stats.startedAt) / 60000), cycles: stats.cycles, alerts: stats.alerts, pings: healthHits, markets: markets.length, borrowers: [...borrowers.values()].reduce((a, x) => a + x.length, 0) }));
});
server.listen(process.env.PORT || 3000);

async function main() {
  tg("🟢 云监控上线: 正在加载市场...");
  for (let i = 0; i < 10; i++) {
    try { await fetchMarketsAndBorrowers(); break; } catch { await new Promise((r) => setTimeout(r, 5000)); }
  }
  const totalB = [...borrowers.values()].reduce((a, x) => a + x.length, 0);
  tg("🟢 监控就绪: " + markets.length + " 个市场, " + totalB + " 个借款人");
  let lastHeartbeat = Date.now();
  let lastRefresh = Date.now();
  while (true) {
    try {
      await cycle();
      if (Date.now() - lastRefresh > 30 * 60 * 1000) {
        try { await fetchMarketsAndBorrowers(); } catch {}
        lastRefresh = Date.now();
      }
      if (Date.now() - lastHeartbeat > 60 * 60 * 1000) {
        const h = Math.round((Date.now() - stats.startedAt) / 3600000);
        const totalB2 = [...borrowers.values()].reduce((a, x) => a + x.length, 0);
        tg("🫀 心跳: 已运行 " + h + "h | 周期 " + stats.cycles + " | 价格变化 " + stats.priceChanges + " | 警报 " + stats.alerts + " | 被ping " + healthHits + " 次 | 市场 " + markets.length + " | 借款人 " + totalB2);
        lastHeartbeat = Date.now();
      }
    } catch {}
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
main();
