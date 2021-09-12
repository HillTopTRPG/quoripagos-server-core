import {ApplicationError} from "../_error/ApplicationError";
import {CoreInner} from "./index";
import {ClientRoomData, Core, RoomStore, SocketStore, StoreData, TokenStore, UserStore} from "../index";

export class CoreInnerImpl implements CoreInner {
  public constructor(private core: Core) {}

  public async deleteExpiredToken(): Promise<number> {
    const collection = await this.core._dbInner.getCollection<TokenStore>(this.core.COLLECTION_TOKEN, false);
    const result = await collection.deleteMany({ expires: { $lt: Date.now() } });
    return result.deletedCount;
  }

  /**
   * bootUp時にDBの内容を整える
   */
  public async updateAtBootUp(): Promise<void> {
    // socket接続情報を初期化
    const socketCollection = await this.core._dbInner.getCollection<SocketStore>(this.core.COLLECTION_SOCKET, false);
    await socketCollection.deleteMany({});

    // 入室済み人数を初期化
    const roomCollection = await this.core._dbInner.getCollection<StoreData<RoomStore>>(this.core.COLLECTION_ROOM, false);
    await roomCollection.updateMany({}, [{$addFields: { data: { memberNum: 0 } }}]);

    // ユーザのログイン済み人数を初期化
    // 非同期処理を直列で実行していく
    const roomStoreList = await roomCollection.find().toArray();
    await this.core.lib.gatlingAsync<void>(
      roomStoreList.map(async room => {
        const roomCollectionPrefix = room.data?.roomCollectionPrefix;
        const userListCollection = await this.core._dbInner.getCollection<StoreData<UserStore>>(["user-list", roomCollectionPrefix], false);
        await userListCollection.updateMany({}, [{$addFields: { data: { login: 0 } } }]);
      })
    );
  }

  public async deleteTouchedRoom(): Promise<number> {
    const collection = await this.core._dbInner.getCollection<StoreData<RoomStore>>(this.core.COLLECTION_ROOM, false);
    const d = new Date();
    d.setMinutes(d.getMinutes() - 5);
    const time = d.getTime();
    const r = await collection.find({ $and: [{createDateTime: { $lt: time }}, {data: null}] }).toArray();
    await collection.deleteMany({ $and: [{createDateTime: { $lt: time }}, {data: null}] });

    if (r.length) {
      // クライアントへの通知
      await this.core.socket.emitSocketEvent(
        null,
        "all",
        "notify-room-delete",
        null,
        r.map(r => r.order)
      );
    }
    return r.length;
  }

  public async socketIn(socket: any): Promise<void> {
    await this.core._dbInner.dbInsertOneRaw<SocketStore>({
        socketId: socket.id,
        connectTime: Date.now(),
        roomNo: null,
        roomKey: null,
        roomCollectionPrefix: null,
        storageId: null,
        userKey: null,
        userName: null
      },
      this.core.COLLECTION_SOCKET
    )
  }

  public async socketOut(socket: any): Promise<void> {
    const {socketInfo, socketCollection} = await this.core._dbInner.getSocketInfo(socket);

    if (socketInfo.roomKey && !socketInfo.roomCollectionPrefix) {
      // タッチした部屋を解放

      const {data: roomData, collection: roomCollection} = await this.core._dbInner.dbFindOne({key: socketInfo.roomKey}, this.core.COLLECTION_ROOM);
      if (roomData) {
        await roomCollection.deleteOne({ key: socketInfo.roomKey });

        // クライアントへの通知
        await this.core.socket.emitSocketEvent(
          socket,
          "all",
          "notify-room-delete",
          null,
          [roomData.order]
        );
      }
    }

    if (socketInfo.roomKey && socketInfo.userKey) {
      // ログインした部屋からログアウト
      console.log("ログアウト処理")
      const {
        data: roomInfo,
        collection: roomCollection
      } = await this.core._dbInner.dbFindOne<RoomStore>({ key: socketInfo.roomKey }, this.core.COLLECTION_ROOM);

      if (!roomInfo)
        throw new ApplicationError(`No such room. room-key=${socketInfo.roomKey}`);

      // ログアウト処理
      const {
        data: userInfo,
        collection: userCollection
      } = await this.core._dbInner.dbFindOne<UserStore>({ key: socketInfo.userKey }, ["user-list", roomInfo.data!.roomCollectionPrefix!]);

      if (!userInfo)
        throw new ApplicationError(`No such user. user-key=${socketInfo.userKey}`);

      userInfo.data!.login--;

      const updateUserInfo = { key: socketInfo.userKey, data: {login: userInfo.data!.login} };
      await this.core._simpleDb.updateSimple(
        socket,
        userCollection,
        "none",
        updateUserInfo
      );

      if (userInfo.data!.login === 0) {
        roomInfo.data!.loggedIn--;
        const updateDateTime = Date.now();
        await roomCollection.updateOne(
          { key: socketInfo.roomKey },
          [{ $addFields: { data: {loggedIn: roomInfo.data!.loggedIn}, updateDateTime } }]
        );

        // クライアントへの通知
        await this.core.socket.emitSocketEvent<ClientRoomData>(
          socket,
          "all",
          "notify-room-update",
          null,
          {
            roomNo: roomInfo.order,
            status: roomInfo.status,
            operator: socket.id,
            createDateTime: roomInfo.createDateTime,
            updateDateTime: updateDateTime,
            detail: {
              roomName: roomInfo.data!.name,
              loggedIn: roomInfo.data!.loggedIn,
              memberNum: roomInfo.data!.memberNum,
              extend: roomInfo.data!.extend
            }
          }
        );
      }
    }

    await socketCollection.deleteOne({ socketId: socket.id });
  }
}
