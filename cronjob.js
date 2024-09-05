import {CronJob} from "cron";
import moment from "moment";
import SteamClient from "steamutils/SteamClient.js";
import {collection, requireDB} from "./db.js";


export async function initCron() {
    console.log("initCron");

    new CronJob(
        "0 */15 * * * *",
        async function () {
            const t1 = performance.now()
            await requireDB(async function (collection) {
                const fetchedSteamIds = []
                const myAccounts = await collection.MyAccount.find({
                    prime: true,
                    banned: {$ne: true}
                }).project({
                    steamId: 1,
                    cookie: 1,
                    friendsIDList: 1,
                }).toArray()

                const myAccountSteamIds = myAccounts.map(({steamId}) => steamId)
                console.log(`Total: ${myAccountSteamIds.length} accounts`);

                for (const myAccount of myAccounts) {
                    const steamId = myAccount.steamId;
                    if (fetchedSteamIds.includes(steamId)) {
                        continue
                    }

                    const needFetchedSteamIds = [steamId, ...(myAccount.friendsIDList || [])].filter(function (friendSteamId) {
                        return myAccountSteamIds.includes(friendSteamId) && !fetchedSteamIds.includes(friendSteamId)
                    });

                    if (needFetchedSteamIds.length) {
                        await SteamClient.isAccountPlayable({
                            cookie: myAccount.cookie,
                            async onPlayable(client) {
                                for (const friendSteamId of needFetchedSteamIds) {
                                    console.log("fetching profile", friendSteamId);
                                    const profile = await fetchPlayerProfile(friendSteamId, client)
                                    if (profile) {
                                        fetchedSteamIds.push(friendSteamId)
                                    }
                                }
                            }
                        })
                    }
                }
            })
            const t2 = performance.now()
            console.log(`Fetch my profiles took ${t2 - t1}ms`)
        },
        null,
        true,
        "Asia/Ho_Chi_Minh",
    ).start();
}

export async function fetchPlayerProfile(steamId, steamClient) {
    if (!steamClient) {
        return
    }
    const profile = await steamClient.getPlayersProfile(steamId);
    if (!profile) {
        return null;
    }

    // Update MyAccount if applicable
    const myAccount = await collection.MyAccount.findOne({steamId});
    if (myAccount) {
        const currentXP = profile.current_xp;
        const update = calculateMyAccountXP(myAccount, currentXP) || {};
        Object.assign(update, {
            prime: !!profile.prime,
            profile,
            ...(typeof profile.elo === "number" && {elo: profile.elo}),
            ...(profile.vac_banned === 1 && {banned: true}),
        });

        if (typeof profile.player_level === "number" && profile.player_level) {
            update.CSGO_Profile_Rank = profile.player_level;
            if (profile.player_level >= 10) {
                update.premierAvaiable = true;
            }
        }

        await collection.MyAccount.updateOne({_id: myAccount._id}, {
            $set: update,
        });
    }

    await collection.Friend.updateOne(
        {steamId},
        {
            $set: {
                primeStatus: profile.prime ? "prime" : "non-prime",
                profile,
                lastTimeFetchPlayerProfile: new Date().getTime(),
                ...(typeof profile.elo === "number" && {elo: profile.elo}),
                ...(profile.vac_banned === 1 && {banned: true}),
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
    const update = {currentXp: nextXp};
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
