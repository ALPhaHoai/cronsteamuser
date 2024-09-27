import { CronJob } from "cron";
import moment from "moment";
import SteamClient from "steamutils/SteamClient.js";
import { collection } from "./db.js";
import _ from "lodash";
import SteamUser from "steamutils";
import DiscordUser from "discord-control";
import {
  getDiscordToken,
  l2pClient,
  sendDiscordMessage,
  sendMsgClient,
} from "./core.js";

export async function initCron() {
  console.log("initCron");

  new CronJob(
    "0 */30 * * * *",
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
    "0 35 */5 * * *",
    async function () {
      const t1 = performance.now();
      const accounts = await collection.MyAccount.find()
        .project({
          steamId: 1,
          cookie: 1,
          friendsIDList: 1,
        })
        .toArray();
      while (accounts.length) {
        const account = accounts.shift();
        if (!account) {
          break;
        }
        await fetchSteamUserSummary(account);
      }
      const t2 = performance.now();
      console.log(`fetchSteamUserSummary took ${t2 - t1}ms`); //3hours
    },
    null,
    true,
    "Asia/Ho_Chi_Minh",
  ).start();

  new CronJob(
    "*/15 * * * * *",
    async function () {
      if (!l2pClient) {
        return;
      }
      const competitivePlayers =
        (await l2pClient.partySearch({
          prime: true,
          game_type: "Competitive",
          rank: 0,
          timeout: 60000,
        })) || [];
      const wingmanPlayers =
        (await l2pClient.partySearch({
          prime: true,
          game_type: "Wingman",
          rank: 0,
          timeout: 60000,
        })) || [];

      const players = _.uniqBy(
        [...competitivePlayers, ...wingmanPlayers],
        "steamId",
      );

      if (!players.length) {
        return;
      }
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
    },
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
    const currentXP = profile.current_xp;
    const update = calculateMyAccountXP(myAccount, currentXP) || {};
    Object.assign(update, {
      prime: !!profile.prime,
      ...(typeof profile.elo === "number" && { elo: profile.elo }),
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

export function calculateMyAccountXP(myAccount, nextXp) {
  if (!Number.isFinite(nextXp)) {
    return;
  }

  const currentXp = myAccount.currentXp || 0;
  const update = { currentXp: nextXp };
  if (nextXp < currentXp) {
    update.xpExceed = Date.now();
  }
  const resetDay = getBonusXpTimeRefresh().format("YYYY-MM-DD");
  const isWeekReset = myAccount.xpEarnedThisWeek !== resetDay;
  let xpEarnedThisRank = nextXp - currentXp;
  if (xpEarnedThisRank < 0) {
    xpEarnedThisRank += 5000;
  }
  if (isWeekReset) {
    update.xpEarnedThisWeek = resetDay;
    update.xpEarned = xpEarnedThisRank;
  } else {
    update.xpEarned = (myAccount.xpEarned || 0) + xpEarnedThisRank;
    if (xpEarnedThisRank === 0) {
      return;
    }
  }

  return update;
}

export function getBonusXpTimeRefresh() {
  let resetDay = moment.utc().startOf("isoWeek").add(2, "days").add(1, "hours");
  while (moment().isAfter(resetDay)) {
    resetDay = resetDay.add(7, "days");
  }
  if (moment().isBefore(resetDay)) {
    resetDay = resetDay.subtract(7, "days");
  }
  return resetDay;
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

    if (needFetchedSteamIds.length) {
      needFetchedSteamIds = _.shuffle(needFetchedSteamIds);
      needFetchedSteamIds.length = Math.min(15, needFetchedSteamIds.length);
      await SteamClient.isAccountPlayable({
        cookie: myAccount.cookie,
        async onPlayable(client) {
          for (const friendSteamId of needFetchedSteamIds) {
            console.log(
              `fetching ${includeFriend ? "friend" : "my"} profile`,
              friendSteamId,
            );
            const profile = await fetchPlayerProfile(friendSteamId, client);
            if (profile) {
              fetchedSteamIds.push(friendSteamId);
            }
          }
        },
      });
    }
  }
  const t2 = performance.now();
  console.log(
    `Fetch ${includeFriend ? "friend" : "my"} profiles took ${t2 - t1}ms`,
  );
}

async function fetchSteamUserSummary(account) {
  if (!account) {
    return;
  }
  const steamUser = new SteamUser(account.cookie);
  const friendsIDList = account.friendsIDList || [];

  async function fetchFriend(steamId) {
    if (!steamId) {
      return;
    }
    await collection.Job.updateOne(
      {
        jobName: "fetchFriendSummary",
        steamId: steamId,
      },
      {
        $set: {
          jobName: "fetchFriendSummary",
          steamId: steamId,
          timestamp: Date.now(),
        },
      },
      {
        upsert: true,
      },
    );

    const summary = await steamUser.getUserSummary(steamId);
    if (!summary?.name || !summary?.steamId) {
      return;
    }

    const friend = await collection.Friend.findOne({ steamId });

    const $set = {};
    const $addToSet = {};

    if (
      summary?.isVACBan === 1 ||
      summary?.isGameBan === 1 ||
      summary?.isTradeBan === 1
    ) {
      $set.banned = true;
    }
    if (typeof summary.level === "number") {
      $set.steamLevel = summary.level;
    }
    if (typeof summary.memberSince === "number") {
      $set.memberSince = summary.memberSince;
    }
    if (typeof summary.isLimitedAccount === "number") {
      $set.limited_account = summary.isLimitedAccount;
    }
    if (summary.name) {
      $set.personaName = summary.name;
      $addToSet.historyName = summary.name;
    }
    if (summary.avatarHash) {
      $set.avatarHash = summary.avatarHash;
      $addToSet.avatarHistory = summary.avatarHash;
    }

    if (Object.keys($set).length) {
      await collection.MyAccount.updateOne({ steamId }, { $set });

      await collection.Friend.updateOne(
        { steamId },
        { $set },
        {
          upsert: true,
        },
      );
    }

    if (Object.keys($addToSet).length) {
      await collection.FriendInfo.updateOne(
        { steamId },
        {
          $addToSet,
        },
        {
          upsert: true,
        },
      );
    }

    let banned = "";
    if (summary.isVACBan === 1) {
      banned = "VAC ban";
    } else if (summary.isGameBan === 1) {
      banned = "Game ban";
    }

    if (friend && !friend.banned && banned) {
      //just get banned
      const botNatriDiscord = new DiscordUser(
        await getDiscordToken("botnatri"),
      );
      await botNatriDiscord.sendMessage({
        channelId: "1242161465205719110",
        content: `[${summary.name.replaceAll(/\p{Extended_Pictographic}/gu, "")}](${summary.url}) : ${banned}`,
      });
    }
  }

  while (friendsIDList.length) {
    const steamId = friendsIDList.shift();
    if (!steamId) {
      break;
    }
    await fetchFriend(steamId);
  }
}
