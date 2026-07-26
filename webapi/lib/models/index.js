import { sequelize } from "../db.js";
import { ContentTag } from "./content-tag.js";
import { FeaturedVideo } from "./featured-video.js";
import { FileVersion } from "./file-version.js";
import { Notification } from "./notification.js";
import { OriginalUpload } from "./original-upload.js";
import { PlaylistItem } from "./playlist-item.js";
import { Role } from "./role.js";
import { SsoProvider } from "./sso-provider.js";
import { StaticPage } from "./static-page.js";
import { Subscription } from "./subscription.js";
import { User } from "./user.js";
import { UserIdentity } from "./user-identity.js";
import { UserNotificationSetting } from "./user-notification-setting.js";
import { UserPlaylist } from "./user-playlist.js";
import { VideoLike } from "./video-like.js";
import { VideoMetadata } from "./video-metadata.js";

/**
 * Registers associations between models so foreign keys and cascades match the
 * previous hand-written schema.
 *
 * @returns {void} No return value; mutates model association registries.
 */
function registerAssociations() {
  Role.hasMany(User, {
    foreignKey: "roleId",
    onDelete: "SET NULL",
  });
  User.belongsTo(Role, {
    foreignKey: "roleId",
    onDelete: "SET NULL",
  });

  User.hasMany(UserIdentity, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  UserIdentity.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  SsoProvider.hasMany(UserIdentity, {
    foreignKey: "providerId",
    onDelete: "CASCADE",
  });
  UserIdentity.belongsTo(SsoProvider, {
    foreignKey: "providerId",
    onDelete: "CASCADE",
  });

  User.hasMany(OriginalUpload, {
    foreignKey: "userId",
    onDelete: "SET NULL",
  });
  OriginalUpload.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "SET NULL",
  });

  OriginalUpload.hasOne(VideoMetadata, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  VideoMetadata.belongsTo(OriginalUpload, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });

  OriginalUpload.hasMany(FileVersion, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  FileVersion.belongsTo(OriginalUpload, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });

  User.hasMany(UserPlaylist, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  UserPlaylist.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  UserPlaylist.hasMany(PlaylistItem, {
    foreignKey: "playlistId",
    onDelete: "CASCADE",
  });
  PlaylistItem.belongsTo(UserPlaylist, {
    foreignKey: "playlistId",
    onDelete: "CASCADE",
  });

  OriginalUpload.hasMany(PlaylistItem, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  PlaylistItem.belongsTo(OriginalUpload, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });

  User.hasMany(VideoLike, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  VideoLike.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  OriginalUpload.hasMany(VideoLike, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  VideoLike.belongsTo(OriginalUpload, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });

  OriginalUpload.hasMany(ContentTag, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  ContentTag.belongsTo(OriginalUpload, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });

  OriginalUpload.hasOne(FeaturedVideo, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  FeaturedVideo.belongsTo(OriginalUpload, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });

  User.hasMany(Subscription, {
    as: "SubscriptionsMade",
    foreignKey: "subscriberId",
    onDelete: "CASCADE",
  });
  Subscription.belongsTo(User, {
    as: "Subscriber",
    foreignKey: "subscriberId",
    onDelete: "CASCADE",
  });

  User.hasMany(Subscription, {
    as: "SubscriptionsReceived",
    foreignKey: "subscribedToId",
    onDelete: "CASCADE",
  });
  Subscription.belongsTo(User, {
    as: "SubscribedTo",
    foreignKey: "subscribedToId",
    onDelete: "CASCADE",
  });

  User.hasMany(Notification, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  Notification.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  User.hasMany(UserNotificationSetting, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  UserNotificationSetting.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
}

registerAssociations();

/**
 * All registered Sequelize models for the application schema.
 *
 * @type {object}
 */
export const models = {
  Role,
  User,
  SsoProvider,
  UserIdentity,
  OriginalUpload,
  VideoMetadata,
  FileVersion,
  UserPlaylist,
  PlaylistItem,
  VideoLike,
  ContentTag,
  FeaturedVideo,
  Subscription,
  Notification,
  UserNotificationSetting,
  StaticPage,
};

export {
  ContentTag,
  FeaturedVideo,
  FileVersion,
  Notification,
  OriginalUpload,
  PlaylistItem,
  Role,
  SsoProvider,
  StaticPage,
  Subscription,
  User,
  UserIdentity,
  UserNotificationSetting,
  UserPlaylist,
  VideoLike,
  VideoMetadata,
};

export { sequelize };
