require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder
} = require("discord.js");
const axios = require("axios");

// ============================================================================
// CONFIGURATION - Edit these or use .env
// ============================================================================

const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  GUILD_ID: process.env.DISCORD_GUILD_ID,
  RANKGUN_API_KEY: process.env.RANKGUN_API_KEY || 'ENTER_KEY_HERE',
  RANKGUN_API_URL: process.env.RANKGUN_API_URL || 'https://api.rankgun.works',
  ROBLOX_GROUP_ID: Number(process.env.ROBLOX_GROUP_ID) || 12345678,
  MAX_RANK: 123,
  ROLE_REQUIRED: process.env.RANK_ROLE_ID || null,
  EMBED_COLOR: 0xbb1b1a
};


if (!CONFIG.TOKEN) {
  console.error("DISCORD_TOKEN not set in .env");
  process.exit(1);
}

if (!CONFIG.CLIENT_ID) {
  console.error("DISCORD_CLIENT_ID not set in .env");
  process.exit(1);
}


async function resolveUserId(input) {
  const numeric = /^\d+$/.test(input) ? Number(input) : null;
  if (numeric) return numeric;

  try {
    const res = await axios.post(
      'https://users.roblox.com/v1/usernames/users',
      { usernames: [input] },
      { timeout: 5000 }
    );
    const user = res.data?.data?.[0];
    return user?.id || null;
  } catch (err) {
    return null;
  }
}

async function resolveRobloxUsername(userId) {
  try {
    const res = await axios.get(`https://users.roblox.com/v1/users/${userId}`, { timeout: 5000 });
    return res.data?.name || String(userId);
  } catch (err) {
    return String(userId);
  }
}

async function fetchGroupRoles() {
  const res = await axios.get(
    `https://groups.roblox.com/v1/groups/${CONFIG.ROBLOX_GROUP_ID}/roles`,
    { timeout: 7000 }
  );
  return res.data.roles || [];
}

function findRole(input, roles) {
  const lowered = String(input || '').toLowerCase();

  const asNum = Number(input);
  if (!Number.isNaN(asNum)) {
    const byRank = roles.find(r => Number(r.rank) === asNum);
    if (byRank) return byRank;
  }

  const byName = roles.find(r => (r.name || '').toLowerCase() === lowered);
  if (byName) return byName;

  const partial = roles.find(r => (r.name || '').toLowerCase().includes(lowered));
  return partial || null;
}

async function updateUserRank(userId, rankNumber, reason) {
  const payload = {
    userId: Number(userId),
    rankId: Number(rankNumber),
    reason: reason || undefined
  };

  const headers = {
    'x-api-key': CONFIG.RANKGUN_API_KEY,
    'Content-Type': 'application/json'
  };

  const url = `${CONFIG.RANKGUN_API_URL}/api/roblox/setrank`;
  const res = await axios.post(url, payload, { headers, timeout: 7000 });
  return res.data;
}


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ]
});

let rolesCache = { ts: 0, roles: [] };

async function getRoles() {
  if (!rolesCache.ts || (Date.now() - rolesCache.ts) > 60_000) {
    rolesCache.roles = await fetchGroupRoles();
    rolesCache.ts = Date.now();
  }
  return rolesCache.roles;
}

client.on('ready', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  const rest = client.rest;
  const applicationId = client.application?.id || CONFIG.CLIENT_ID;

  const commands = [
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Set a user rank in the Roblox group')
      .addStringOption(opt => opt.setName('username').setDescription('Roblox username or user ID').setRequired(true))
      .addStringOption(opt => opt.setName('rank').setDescription('Rank name or number').setRequired(true).setAutocomplete(true))
      .addStringOption(opt => opt.setName('reason').setDescription('Reason for rank change').setRequired(true))
  ];

  try {
    if (CONFIG.GUILD_ID) {
      await rest.put(
        `/applications/${applicationId}/guilds/${CONFIG.GUILD_ID}/commands`,
        { body: commands }
      );
    } else {
      await rest.put(
        `/applications/${applicationId}/commands`,
        { body: commands }
      );
    }
  } catch (err) {
    console.error('Failed to register commands:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'rank') {
    try {
      await interaction.deferReply({ ephemeral: true });

      // Check permissions
      const allowed = !CONFIG.ROLE_REQUIRED || interaction.member?.roles?.cache?.has(CONFIG.ROLE_REQUIRED);
      if (!allowed) {
        await interaction.editReply('You do not have permission to use this command.');
        return;
      }

      const username = interaction.options.getString('username', true).trim();
      const rankInput = interaction.options.getString('rank', true).trim();
      const reason = interaction.options.getString('reason', true).trim();

      // Resolve user
      const userId = await resolveUserId(username);
      if (!userId) {
        await interaction.editReply(`Could not resolve user: **${username}**`);
        return;
      }

      const resolvedUsername = await resolveRobloxUsername(userId);

      // Fetch roles
      let roles = [];
      try {
        roles = await getRoles();
      } catch (err) {
        await interaction.editReply('Failed to fetch group roles.');
        return;
      }

      if (roles.length === 0) {
        await interaction.editReply('No roles found.');
        return;
      }

      // Find rank
      const targetRole = findRole(rankInput, roles);
      if (!targetRole) {
        const sample = roles.slice(0, 5).map(r => r.name).join(', ');
        await interaction.editReply(`Rank not found. Examples: ${sample}`);
        return;
      }

      // Update rank
      try {
        await updateUserRank(userId, targetRole.rank, reason);

        const embed = new EmbedBuilder()
          .setColor(CONFIG.EMBED_COLOR)
          .setTitle('Rank Updated')
          .addFields(
            { name: 'Roblox Username', value: resolvedUsername, inline: true },
            { name: 'New Rank', value: targetRole.name, inline: true },
            { name: 'Reason', value: reason, inline: false }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        console.log(`${interaction.user.tag} ranked ${resolvedUsername} (${userId}) -> ${targetRole.name}`);
      } catch (err) {
        const errMsg = err?.response?.data?.message || err?.response?.data?.error || err.message;
        await interaction.editReply(`Failed to update rank: ${errMsg}`);
        console.error('Rank update error:', errMsg);
      }
    } catch (err) {
      console.error('Command error:', err);
      try {
        await interaction.editReply('An error occurred.');
      } catch (e) {
        /* ignore */
      }
    }
  }

  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused();
    try {
      const roles = await getRoles();
      const q = String(focused || '').toLowerCase();

      const filtered = roles
        .filter(r => Number(r.rank) <= CONFIG.MAX_RANK)
        .filter(r => !q || r.name?.toLowerCase().includes(q) || String(r.rank).includes(q));

      const choices = filtered.slice(0, 25).map(r => ({ name: r.name || 'Unnamed', value: String(r.rank) }));
      await interaction.respond(choices);
    } catch (err) {
      console.error('Autocomplete error:', err.message);
      await interaction.respond([]);
    }
  }
});

client.login(CONFIG.TOKEN);
