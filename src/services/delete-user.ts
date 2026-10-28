import { Account } from '../models/Account.js';
import { Alert } from '../models/Alert.js';
import { Extra } from '../models/Extra.js';
import { Holding } from '../models/Holding.js';
import { Movement } from '../models/Movement.js';
import { Notification } from '../models/Notification.js';
import { Plan } from '../models/Plan.js';
import { Snapshot } from '../models/Snapshot.js';
import { User } from '../models/User.js';
import { Wallet } from '../models/Wallet.js';

export async function deleteUserData(userId: string): Promise<void> {
  const mine = { userId };
  await Promise.all([
    Account.deleteMany(mine),
    Holding.deleteMany(mine),
    Movement.deleteMany(mine),
    Plan.deleteMany(mine),
    Extra.deleteMany(mine),
    Wallet.deleteMany(mine),
    Snapshot.deleteMany(mine),
    Alert.deleteMany(mine),
    Notification.deleteMany(mine),
  ]);
  await User.deleteOne({ _id: userId });
}
