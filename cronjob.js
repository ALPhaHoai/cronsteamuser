import { CronJob } from "cron";
import SteamClient from "steamutils/SteamClient.js";
import { collection } from "./db.js";
import _ from "lodash";
import {
  initL2P,
  l2pClient,
  sendDiscordMessage,
  sendMsgClient,
} from "./core.js";
import { calculateAccountXP } from "steamutils/utils.js";
import moment from "moment";

export async function initCron() {
  console.log("initCron");

  new CronJob(
    "0 30 * * * *",
    async function () {
      await fetchPlayersProfile(false);
    },
    null,
    true,
    "Asia/Ho_Chi_Minh",
  ).start();

  new CronJob(
    "0 35 */3 * * *",
    async function () {
      await fetchPlayersProfile(true);
    },
    null,
    true,
    "Asia/Ho_Chi_Minh",
  ).start();

  new CronJob(
    "0 * * * * *",
    partySearchCron,
    null,
    true,
    "Asia/Ho_Chi_Minh",
  ).start();
}

export async function fetchPlayerProfile(steamId, steamClient) {
  if (!steamClient) {
    return;
  }
  const profile = await steamClient.getPlayersProfile(steamId);
  if (!profile) {
    return null;
  }

  console.log(`[${steamId}] ELO: ${profile.elo} ${typeof profile.elo}`);

  // Update MyAccount if applicable
  const myAccount = await collection.MyAccount.findOne({ steamId });
  if (myAccount) {
    const update = calculateAccountXP(
      myAccount.currentXp,
      myAccount.xpEarnedThisWeek,
      myAccount.xpEarned,
      profile.current_xp,
    );
    Object.assign(update, {
      prime: !!profile.prime,
      ...(typeof profile.elo === "number" &&
        profile.elo && { elo: profile.elo }),
    });

    if (typeof profile.player_level === "number" && profile.player_level) {
      update.CSGO_Profile_Rank = profile.player_level;
      if (profile.player_level >= 10) {
        update.premierAvaiable = true;
      }
    }

    await collection.MyAccount.updateOne(
      { _id: myAccount._id },
      {
        $set: update,
      },
    );
  }

  await collection.Friend.updateOne(
    { steamId },
    {
      $set: {
        prime: !!profile.prime,
        lastTimeFetchPlayerProfile: Date.now(),
        ...(typeof profile.elo === "number" && { elo: profile.elo }),
      },
    },
  );
  return profile;
}

async function fetchPlayersProfile(includeFriend = false) {
  console.log(`Fetching ${includeFriend ? "friend" : "my"} profiles`);

  //includeFriend: friend or my account

  const t1 = performance.now();
  const fetchedSteamIds = [];
  const myAccounts = await collection.MyAccount.find({
    "config.store": { $ne: true },
    banned: { $ne: true },
  })
    .project({
      steamId: 1,
      cookie: 1,
      friendsIDList: 1,
      competitiveCooldownLevel: 1,
    })
    .toArray();

  const myAccountSteamIds = myAccounts.map(({ steamId }) => steamId);
  console.log(`Total: ${myAccountSteamIds.length} accounts`);

  while (myAccounts.length) {
    const myAccount = myAccounts.shift();
    if (!myAccount) {
      break;
    }
    const steamId = myAccount.steamId;
    if (fetchedSteamIds.includes(steamId)) {
      continue;
    }

    let needFetchedSteamIds = [
      steamId,
      ...(myAccount.friendsIDList || []),
    ].filter(function (friendSteamId) {
      if (fetchedSteamIds.includes(friendSteamId)) {
        return false;
      }
      if (includeFriend) {
        return true;
      }
      return myAccountSteamIds.includes(friendSteamId);
    });

    if (!needFetchedSteamIds.length) {
      continue;
    }

    needFetchedSteamIds = _.shuffle(needFetchedSteamIds);
    needFetchedSteamIds.length = Math.min(30, needFetchedSteamIds.length);
    const steamClient = new SteamClient({ cookie: myAccount.cookie });
    const playable = await steamClient.playCSGOSilent();
    if (playable) {
      const cooldown_table =
        myAccount.competitiveCooldownLevel?.cooldown_table?.[0];
      const cooldownExpiration =
        cooldown_table?.Competitive_Cooldown_Expiration?.replace(
          "GMT",
          "",
        )?.trim();

      if (
        cooldownExpiration &&
        cooldown_table?.Acknowledged === "No" &&
        moment.utc(cooldownExpiration).isBefore(moment()) &&
        Math.random() > 0.7
      ) {
        steamClient.acknowledgePenalty();
      }
      for (const friendSteamId of needFetchedSteamIds) {
        console.log(
          `fetching ${includeFriend ? "friend" : "my"} profile`,
          friendSteamId,
        );
        const profile = await fetchPlayerProfile(friendSteamId, steamClient);
        if (profile) {
          fetchedSteamIds.push(friendSteamId);
        }
      }
    }
    steamClient.offAllEvent();
    steamClient.logOff();
  }
  const t2 = performance.now();
  console.log(
    `Fetch ${includeFriend ? "friend" : "my"} profiles took ${t2 - t1}ms`,
  );
}

let failCount = 0;
let initingL2P = false;
async function partySearchCron() {
  if (!l2pClient || initingL2P) {
    return;
  }
  if (failCount > 30) {
    console.warn(`failCount exceeded 30. Resetting and reinitializing L2P.`);
    failCount = 0;
    initingL2P = true;
    try {
      await initL2P();
    } catch (e) {
      console.error("Error initializing L2P:", e);
    }
    initingL2P = false;
    return;
  }

  l2pClient.log("partySearch");

  const competitivePlayers =
    (await l2pClient.partySearch({
      prime: true,
      rank: "Gold Nova I",
      game_type: "Competitive",
      timeout: 60000,
    })) || [];
  const nonPrimeCompetitivePlayers =
    (await l2pClient.partySearch({
      prime: false,
      rank: "Gold Nova I",
      game_type: "Competitive",
      timeout: 60000,
    })) || [];

  const players = _.uniqBy(
    [...competitivePlayers, ...nonPrimeCompetitivePlayers],
    "steamId",
  );

  if (!players.length) {
    console.warn("No players found in party search.");
    failCount++;
    return;
  }

  l2pClient.log("partySearch result", players.length);

  let hasFollowPlayers = false;
  for (const player of players) {
    const followPlayer = await collection.Friend.countDocuments({
      steamId: player.steamId,
      isFollow: true,
    });
    if (followPlayer) {
      hasFollowPlayers = true;
      const msg = [];
      msg.push("L2P");
      msg.push(player.prime);
      msg.push(player.player_name);
      msg.push(player.rank);
      msg.push(player.friendCode);
      msg.push(
        `[${player.steamId}](https://steamcommunity.com/profiles/${player.steamId})`,
      );
      sendDiscordMessage(msg);
    }
  }

  if (hasFollowPlayers) {
    const steamId = sendMsgClient.myAccountSteamId;
    if (steamId) {
      sendMsgClient.sendFriendMessage(
        steamId,
        "===(partySearch found following)===",
      );
    }
  }

  for (const player of players) {
    await collection.L2PBoard.updateOne(
      {
        steamId: player.steamId,
      },
      {
        $set: {
          ...player,
          timestamp: Date.now(),
        },
      },
      {
        upsert: true,
      },
    );
  }
}
