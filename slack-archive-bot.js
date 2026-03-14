// slack-archive-bot.js
// Warns channel creators at 85 days of inactivity, archives at 90 days
// Runs daily via cron. Exempt: any channel prefixed with "company-"

const { WebClient } = require("@slack/web-api");
const cron = require("node-cron");
require("dotenv").config();

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// ─── Config ───────────────────────────────────────────────────────────────────
const ARCHIVE_AFTER_DAYS = 90;
const WARN_BEFORE_DAYS   = 5;    // warn at 85 days
const WARN_AT_DAYS       = ARCHIVE_AFTER_DAYS - WARN_BEFORE_DAYS; // 85
const ADMIN_CHANNEL      = "feed-automation-admin";
const EXEMPT_PREFIXES    = ["company-"];
// ──────────────────────────────────────────────────────────────────────────────

function isExempt(channelName) {
  return EXEMPT_PREFIXES.some(prefix => channelName.startsWith(prefix));
}

function daysAgo(unixTimestamp) {
  const ms = Date.now() - unixTimestamp * 1000;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function getAdminChannelId() {
  let cursor;
  do {
    const res = await client.conversations.list({
      types: "public_channel,private_channel",
      limit: 200,
      cursor,
    });
    const match = res.channels.find(c => c.name === ADMIN_CHANNEL);
    if (match) return match.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  throw new Error(`Admin channel #${ADMIN_CHANNEL} not found`);
}

async function getAllChannels() {
  const channels = [];
  let cursor;
  do {
    const res = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    channels.push(...res.channels);
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return channels;
}

async function getLastActivityDays(channelId) {
  try {
    const res = await client.conversations.history({
      channel: channelId,
      limit: 1,
    });
    if (res.messages?.length) {
      return daysAgo(parseFloat(res.messages[0].ts));
    }
  } catch (e) {
    // bot may not be in the channel
  }
  return null;
}

async function getChannelCreator(channelId) {
  try {
    const res = await client.conversations.info({ channel: channelId });
    return res.channel?.creator || null;
  } catch (e) {
    return null;
  }
}

async function sendCreatorDM(creatorId, channelName, daysInactive) {
  const daysLeft = ARCHIVE_AFTER_DAYS - daysInactive;
  try {
    await client.chat.postMessage({
      channel: creatorId,
      text: `👋 Heads up! The channel *#${channelName}* has been inactive for *${daysInactive} days* and will be automatically archived in *${daysLeft} days* unless there is new activity. If this channel is still needed, just post a message in it to reset the timer.`,
    });
  } catch (e) {
    console.error(`Failed to DM creator for #${channelName}:`, e.message);
  }
}

async function sendAdminNotification(adminChannelId, channelName, type, daysInactive, creatorId) {
  const creatorMention = creatorId ? `<@${creatorId}>` : "Unknown";
  const msg = type === "warning"
    ? `⚠️ *Archive Warning:* #${channelName} has been inactive for *${daysInactive} days*. Creator: ${creatorMention}. It will be archived in ${ARCHIVE_AFTER_DAYS - daysInactive} days.`
    : `🗂️ *Channel Archived:* #${channelName} was inactive for *${daysInactive} days* and has been archived. Creator was: ${creatorMention}.`;
  await client.chat.postMessage({ channel: adminChannelId, text: msg });
}

async function runArchiveCheck() {
  console.log(`[${new Date().toISOString()}] Running archive check...`);

  let adminChannelId;
  try {
    adminChannelId = await getAdminChannelId();
  } catch (e) {
    console.error(e.message);
    return;
  }

  const channels = await getAllChannels();
  console.log(`Checking ${channels.length} channels...`);

  for (const channel of channels) {
    if (isExempt(channel.name)) continue;

    // Join the channel so we can read its history
    try {
      await client.conversations.join({ channel: channel.id });
    } catch (e) { /* already a member or private */ }

    const daysInactive = await getLastActivityDays(channel.id);
    if (daysInactive === null) continue;

    const creatorId = await getChannelCreator(channel.id);

    if (daysInactive >= ARCHIVE_AFTER_DAYS) {
      // Archive the channel
      try {
        await client.conversations.archive({ channel: channel.id });
        console.log(`✓ Archived #${channel.name} (${daysInactive} days inactive)`);
        await sendAdminNotification(adminChannelId, channel.name, "archived", daysInactive, creatorId);
      } catch (e) {
        console.error(`✗ Failed to archive #${channel.name}:`, e.message);
      }

    } else if (daysInactive >= WARN_AT_DAYS) {
      // Send warning
      console.log(`⚠ Warning sent for #${channel.name} (${daysInactive} days inactive)`);
      if (creatorId) await sendCreatorDM(creatorId, channel.name, daysInactive);
      await sendAdminNotification(adminChannelId, channel.name, "warning", daysInactive, creatorId);
    }
  }

  console.log("Archive check complete.");
}

// Run daily at 9:00 AM EST (14:00 UTC)
cron.schedule("0 14 * * *", runArchiveCheck);

// Also run once on startup
runArchiveCheck();

console.log("⚡ Archive bot is running — checks daily at 9:00 AM EST");
