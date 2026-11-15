/**
 * pending.js — Pending group chat / message request manager
 * Usage: {prefix}pending [list|accept|reject] [group|user] [no|all|threadID]
 */

const CACHE_TTL = 5 * 60 * 1000; // তালিকা ৫ মিনিট ক্যাশে থাকবে
const MAX_SHOW = 20;             // একবারে সর্বোচ্চ কতটি দেখাবে
const ACTION_DELAY = 500;        // প্রতিটি accept/reject-এর মাঝে বিরতি (ms)
const ACCEPT_MESSAGE = "";       // accept-এর পর গ্রুপে পাঠানো মেসেজ (খালি রাখলে পাঠাবে না)

const listCache = new Map();     // senderID -> { threads, filter, time }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- Helpers ------------------------- */

function threadName(t) {
  if (t.name || t.threadName) return String(t.name || t.threadName);
  const users = t.userInfo || t.participants || [];
  const names = (Array.isArray(users) ? users : [])
    .map((u) => u && (u.name || u.fullName || u.username))
    .filter(Boolean);
  return names.length ? names.join(", ") : "Unnamed thread";
}

function isGroupThread(t) {
  if (typeof t.isGroup === "boolean") return t.isGroup;
  if (t.threadType) return String(t.threadType).toLowerCase() === "group";
  const users = t.userInfo || t.participants || [];
  return Array.isArray(users) && users.length > 2;
}

function snippetOf(t) {
  let s = t.snippet || t.lastMessage || "";
  if (s && typeof s === "object") s = s.body || s.text || "";
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > 40 ? s.slice(0, 40) + "..." : s;
}

function normalize(t) {
  return {
    threadID: String((t && (t.threadID || t.id)) || ""),
    name: threadName(t || {}),
    isGroup: isGroupThread(t || {}),
    messageCount: Number((t && t.messageCount) || 0),
    snippet: snippetOf(t || {}),
    timestamp: Number((t && (t.lastMessageTimestamp || t.timestamp || t.updateTime)) || 0)
  };
}

async function fetchPending(api) {
  if (typeof api.getThreadList !== "function")
    throw new Error("api.getThreadList() এই API wrapper-এ নেই।");

  const map = new Map();
  for (const tag of ["PENDING", "OTHER"]) {
    try {
      const res = await api.getThreadList(100, null, [tag]);
      for (const raw of (res || [])) {
        const t = normalize(raw);
        if (t.threadID && !map.has(t.threadID)) map.set(t.threadID, t);
      }
    }
    catch (err) {
      console.error(`[pending] getThreadList(${tag}):`, (err && (err.message || err)) || err);
    }
  }
  return [...map.values()].sort((a, b) => b.timestamp - a.timestamp);
}

async function acceptThread(api, threadID) {
  if (typeof api.handleMessageRequest === "function") return api.handleMessageRequest(threadID, true);
  if (typeof api.acceptMessageRequest === "function") return api.acceptMessageRequest(threadID);
  if (typeof api.sendMessage === "function") return api.sendMessage("👋", threadID);
  throw new Error("accept করার উপযুক্ত method পাওয়া যায়নি।");
}

async function rejectThread(api, threadID) {
  let done = false;
  if (typeof api.handleMessageRequest === "function") { await api.handleMessageRequest(threadID, false); done = true; }
  else if (typeof api.declineMessageRequest === "function") { await api.declineMessageRequest(threadID); done = true; }
  if (typeof api.deleteThread === "function") { try { await api.deleteThread(threadID); done = true; } catch (e) {} }
  if (!done) throw new Error("reject করার উপযুক্ত method পাওয়া যায়নি।");
}

function parseArgs(args) {
  let action = "list", filter = "all";
  const rest = [];
  for (const raw of (args || [])) {
    const a = String(raw).toLowerCase();
    if (["list", "ls", "show"].includes(a)) action = "list";
    else if (["accept", "acc", "approve", "ok"].includes(a)) action = "accept";
    else if (["reject", "deny", "decline", "remove", "delete", "del"].includes(a)) action = "reject";
    else if (["group", "groups", "box"].includes(a)) filter = "group";
    else if (["user", "users", "single", "inbox"].includes(a)) filter = "user";
    else rest.push(String(raw));
  }
  return { action, filter, rest };
}

function applyFilter(threads, filter) {
  if (filter === "group") return threads.filter((t) => t.isGroup);
  if (filter === "user") return threads.filter((t) => !t.isGroup);
  return threads;
}

function pickTargets(tokens, threads) {
  const picked = new Map();
  const invalid = [];
  const addIndex = (n) => {
    const t = threads[n - 1];
    if (t) picked.set(t.threadID, t); else invalid.push(String(n));
  };

  for (const raw of (tokens || [])) {
    const token = String(raw).toLowerCase();
    if (token === "all") { threads.forEach((t) => picked.set(t.threadID, t)); continue; }

    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      let s = Number(range[1]), e = Number(range[2]);
      if (s > e) [s, e] = [e, s];
      for (let i = s; i <= e; i++) addIndex(i);
      continue;
    }

    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n >= 1 && n <= threads.length) { addIndex(n); continue; }
      const found = threads.find((t) => t.threadID === token);
      if (found) picked.set(found.threadID, found);
      else if (token.length >= 8) picked.set(token, { threadID: token, name: "Unknown", isGroup: false });
      else invalid.push(raw);
      continue;
    }

    const found = threads.find((t) => t.threadID === raw);
    if (found) picked.set(found.threadID, found); else invalid.push(raw);
  }
  return { targets: [...picked.values()], invalid };
}

function registerReply(info, data) {
  const messageID = info && (info.messageID || info.messageId);
  if (!messageID || !global.GoatBot || !global.GoatBot.onReply) return;
  global.GoatBot.onReply.set(messageID, Object.assign({ messageID, commandName: "pending" }, data));
}

async function getThreads(api, senderID, filter) {
  const c = listCache.get(senderID);
  if (c && c.filter === filter && Date.now() - c.time < CACHE_TTL) return c.threads;
  const threads = applyFilter(await fetchPending(api), filter);
  listCache.set(senderID, { threads, filter, time: Date.now() });
  return threads;
}

async function showList({ api, event, message, filter }) {
  const threads = applyFilter(await fetchPending(api), filter);
  listCache.set(event.senderID, { threads, filter, time: Date.now() });

  if (!threads.length)
    return message.reply(`📭 কোনো pending ${filter === "all" ? "request" : filter + " request"} পাওয়া যায়নি।`);

  const g = threads.filter((t) => t.isGroup).length;
  const body = threads.slice(0, MAX_SHOW).map((t, i) =>
    `${i + 1}. ${t.isGroup ? "👥" : "👤"} ${t.name}\n   ├ ID: ${t.threadID}\n   └ Msg: ${t.messageCount}${t.snippet ? ` • "${t.snippet}"` : ""}`
  ).join("\n");

  const text = [
    `📥 PENDING LIST (${threads.length}) — 👥 ${g} | 👤 ${threads.length - g}`,
    "──────────────────",
    body,
    threads.length > MAX_SHOW ? `\n...আরও ${threads.length - MAX_SHOW}টি আছে (প্রথম ${MAX_SHOW}টি দেখানো হলো)` : "",
    "──────────────────",
    'Reply করুন: "accept 1 2" | "reject 3" | "accept all" | "reject all"'
  ].filter(Boolean).join("\n");

  const info = await message.reply(text);
  registerReply(info, { type: "list", author: event.senderID, threads });
}

async function runAction({ api, event, message, action, targets, invalid }) {
  if (targets.length > 3)
    await message.reply(`⏳ ${targets.length}টি thread ${action === "accept" ? "accept" : "reject"} করা হচ্ছে, অপেক্ষা করুন...`);

  const ok = [], fail = [];
  for (const t of targets) {
    try {
      if (action === "accept") {
        await acceptThread(api, t.threadID);
        if (ACCEPT_MESSAGE && typeof api.sendMessage === "function") {
          try { await api.sendMessage(ACCEPT_MESSAGE, t.threadID); } catch (e) {}
        }
      }
      else await rejectThread(api, t.threadID);
      ok.push(t);
    }
    catch (err) {
      fail.push(`${t.name} (${t.threadID}): ${(err && (err.message || err)) || "unknown error"}`);
    }
    await sleep(ACTION_DELAY);
  }

  listCache.delete(event.senderID);

  const lines = [`${action === "accept" ? "✅ Accepted" : "🗑 Rejected"}: ${ok.length}/${targets.length}`];
  if (ok.length) lines.push(...ok.slice(0, 15).map((t, i) => `${i + 1}. ${t.isGroup ? "👥" : "👤"} ${t.name}`));
  if (ok.length > 15) lines.push(`...আরও ${ok.length - 15}টি`);
  if (fail.length) lines.push(`\n❌ Failed (${fail.length}):\n${fail.slice(0, 5).join("\n")}`);
  if (invalid.length) lines.push(`⚠️ Invalid: ${invalid.join(", ")}`);
  return message.reply(lines.join("\n"));
}

async function confirmOrRun({ api, event, message, action, targets, invalid }) {
  if (!targets.length)
    return message.reply(`⚠️ কোনো valid target নির্বাচন করা হয়নি।${invalid.length ? ` Invalid: ${invalid.join(", ")}` : ""}\nউদাহরণ: accept 1 2 | reject all`);

  if (targets.length > 3) {
    const info = await message.reply(`⚠️ আপনি ${targets.length}টি pending thread ${action.toUpperCase()} করতে যাচ্ছেন।\nনিশ্চিত হলে "yes", বাতিল করতে "no" reply করুন।`);
    registerReply(info, { type: "confirm", author: event.senderID, action, targets, invalid });
    return;
  }
  return runAction({ api, event, message, action, targets, invalid });
}

/* ------------------------- Command ------------------------- */

module.exports = {
  config: {
    name: "pending",
    version: "1.0.0",
    author: "YourName",
    countDown: 5,
    role: 2, // শুধুমাত্র bot admin
    shortDescription: "Pending group chat / message request ম্যানেজ করুন",
    longDescription: "Bot ID-তে থাকা pending group chat ও message request দেখুন এবং accept বা reject করুন।",
    category: "box chat",
    guide: "{prefix}pending [group|user]\n{prefix}pending accept <no|all|threadID>\n{prefix}pending reject <no|all|threadID>"
  },

  onStart: async function ({ api, event, args, message }) {
    try {
      const { action, filter, rest } = parseArgs(args);
      if (action === "list") return await showList({ api, event, message, filter });

      const threads = await getThreads(api, event.senderID, filter);
      if (!threads.length) return message.reply("📭 কোনো pending request পাওয়া যায়নি।");
      if (!rest.length) return message.reply(`⚠️ ব্যবহার: {prefix}pending ${action} <no|all|threadID>\nউদাহরণ: ${action} 1 2 | ${action} all`.replace("{prefix}", ""));

      const { targets, invalid } = pickTargets(rest, threads);
      return await confirmOrRun({ api, event, message, action, targets, invalid });
    }
    catch (err) {
      return message.reply(`❌ Error: ${(err && (err.message || err)) || err}`);
    }
  },

  onReply: async function ({ api, event, Reply, message }) {
    try {
      if (!Reply || event.senderID !== Reply.author) return;
      const body = String(event.body || "").trim();
      if (!body) return;

      const remove = () => { try { global.GoatBot.onReply.delete(Reply.messageID); } catch (e) {} };

      if (Reply.type === "confirm") {
        remove();
        if (!["yes", "y", "ok", "confirm", "ha", "হ্যাঁ"].includes(body.toLowerCase()))
          return message.reply("❌ বাতিল করা হয়েছে।");
        return await runAction({ api, event, message, action: Reply.action, targets: Reply.targets || [], invalid: Reply.invalid || [] });
      }

      const { action, filter, rest } = parseArgs(body.split(/\s+/));
      if (action === "list") { remove(); return await showList({ api, event, message, filter }); }

      const threads = (Reply.threads && Reply.threads.length) ? Reply.threads : await getThreads(api, event.senderID, filter);
      const { targets, invalid } = pickTargets(rest, threads);
      remove();
      return await confirmOrRun({ api, event, message, action, targets, invalid });
    }
    catch (err) {
      return message.reply(`❌ Error: ${(err && (err.message || err)) || err}`);
    }
  }
};
