import { MongoClient } from "mongodb";

export const collection = {};

export async function requireDB(callback) {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  console.log("Connected successfully to server");
  const db = client.db("SteamSupportDatabase");
  collection.MyAccount = db.collection("MyAccount");
  collection.Friend = db.collection("Friend");
  collection.FriendInfo = db.collection("FriendInfo");
  collection.Job = db.collection("Job");
  collection.DiscordAccountHeader = db.collection("DiscordAccountHeader");

  try {
    await callback?.(collection);
  } catch (e) {}

  await client.close(true);
  for (const collectionKey in collection) {
    delete collection[collectionKey];
  }
}
