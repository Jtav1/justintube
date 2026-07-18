import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * SUBSCRIPTIONS table model. Records that one user (subscriberId) has subscribed
 * to another user's content (subscribedToId).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const Subscription = sequelize.define(
  "Subscription",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    subscriberId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    subscribedToId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "SUBSCRIPTIONS",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ["subscriber_id", "subscribed_to_id"],
        name: "uq_subscriptions_pair",
      },
    ],
    validate: {
      notSelfSubscription() {
        if (this.subscriberId === this.subscribedToId) {
          throw new Error("A user cannot subscribe to themselves.");
        }
      },
    },
  },
);
