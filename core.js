import { collection } from "./db.js";
import SteamClient from "steamutils/SteamClient.js";
import DiscordUser from "discord-control";

export let l2pClient = null;
export let sendMsgClient = null;

export async function initL2P() {
  console.log("initL2P");

  const privatePrimeAccountSteamIds = (
    await collection.MyAccount.find({
      "config.store": {
        $ne: true,
      },
      banned: {
        $ne: true,
      },
      "config.isPrivate": true,
      prime: true,
    })
      .project({
        steamId: 1,
      })
      .toArray()
  ).map((account) => account.steamId);

  //find send message client (store account)
  console.log("find send message client");
  for await (const account of await collection.MyAccount.aggregate([
    {
      $match: {
        "config.store": true,
        prime: {
          $ne: true,
        },
        friendsIDList: {
          $in: privatePrimeAccountSteamIds,
        },
      },
    },
    {
      $project: {
        cookie: 1,
        friendsIDList: 1,
      },
    },
  ])) {
    const result = await SteamClient.isAccountPlayable({
      cookie: account.cookie,
      isInvisible: false,
      isFakeGameScore: false,
      isPartyRegister: false,
      async onPlayable(client) {
        sendMsgClient = client;
        sendMsgClient.myAccountSteamId = account.friendsIDList.find(
          (steamId) =>
            steamId === privatePrimeAccountSteamIds.includes(steamId),
        );
      },
      keepLoginWhenPlayable: true,
    });
    if (result?.playable) {
      break;
    }
  }

  //find l2p client (prime banned account)
  console.log("find l2p client");
  for await (const account of await collection.MyAccount.aggregate([
    {
      $match: {
        prime: true,
        banned: true,
      },
    },
    { $sample: { size: 100 } },
    {
      $project: {
        cookie: 1,
      },
    },
  ])) {
    const result = await SteamClient.isAccountPlayable({
      cookie: account.cookie,
      isInvisible: false,
      isFakeGameScore: false,
      isPartyRegister: false,
      async onPlayable(client) {
        l2pClient = client;
      },
      keepLoginWhenPlayable: true,
    });
    if (result?.playable) {
      break;
    }
  }
}

export async function sendDiscordMessage(messages) {
  //Send private message from Cinderella to Natri
  const now = moment().tz("Asia/Ho_Chi_Minh").format("DD/MM/YYYY HH:mm:ss");
  const prefixs = [now, isMainCore];
  if (!Array.isArray(messages)) {
    messages = [messages];
  }
  messages = prefixs
    .concat(messages)
    .map(function (txt) {
      return txt?.toString()?.trim();
    })
    .filter(function (txt) {
      return txt !== "" && txt !== undefined;
    })
    .map(function (txt) {
      const space = txt.startsWith("[") ? " " : "";
      return `[${space}${txt}${space}]`;
    })
    .join(" ");

  const cinderellaDiscordUser = new DiscordUser(
    await getDiscordToken("cinderella"),
  );

  const result = await cinderellaDiscordUser.sendMessage({
    channelId: "867276272999464980",
    content: messages,
  });

  if (!result.data?.id) {
    console.error(result.data);
  } else {
    // console.log(result.data);
  }
  return result;
}

export async function getDiscordToken(account) {
  const headers = (await collection.DiscordAccountHeader.findOne({ account }))
    ?.headers;
  const authorizationKey = Object.keys(headers).find(
    (name) => name.toLowerCase() === "authorization",
  );
  if (!authorizationKey) {
    return;
  }
  return headers[authorizationKey];
}
