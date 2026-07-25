import { sequelize } from "../db.js";
import { ContentTag } from "./content-tag.js";
import { EmailVerificationToken } from "./email-verification-token.js";
import { FeaturedVideo } from "./featured-video.js";
import { FileVersion } from "./file-version.js";
import { Notification } from "./notification.js";
import { OriginalUpload } from "./original-upload.js";
import { PlaylistItem } from "./playlist-item.js";
import { Role } from "./role.js";
import { SsoProvider } from "./sso-provider.js";
import { StaticPage } from "./static-page.js";
import { Subscription } from "./subscription.js";
import { SystemConfig } from "./system-config.js";
import { TranscodeProfile } from "./transcode-profile.js";
import { User } from "./user.js";
import { UserApiKey } from "./user-api-key.js";
import { UserIdentity } from "./user-identity.js";
import { UserNotificationSetting } from "./user-notification-setting.js";
import { UserPlaylist } from "./user-playlist.js";
import { VideoAccess } from "./video-access.js";
import { VideoLike } from "./video-like.js";
import { VideoMetadata } from "./video-metadata.js";
import { VideoThumbnail } from "./video-thumbnail.js";
import { VideoTransferHistory } from "./video-transfer-history.js";
import { VideoTransferMapping } from "./video-transfer-mapping.js";

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

  User.hasMany(UserApiKey, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  UserApiKey.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  User.hasMany(EmailVerificationToken, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  EmailVerificationToken.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
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
    as: "VideoMetadata",
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

  OriginalUpload.hasOne(VideoThumbnail, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  VideoThumbnail.belongsTo(OriginalUpload, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });

  User.hasMany(TranscodeProfile, {
    as: "CreatedTranscodeProfiles",
    foreignKey: "creatorUserId",
    onDelete: "SET NULL",
  });
  TranscodeProfile.belongsTo(User, {
    as: "Creator",
    foreignKey: "creatorUserId",
    onDelete: "SET NULL",
  });

  TranscodeProfile.hasMany(FileVersion, {
    foreignKey: "transcodeProfileId",
    onDelete: "SET NULL",
  });
  FileVersion.belongsTo(TranscodeProfile, {
    foreignKey: "transcodeProfileId",
    onDelete: "SET NULL",
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

  User.hasMany(VideoAccess, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  VideoAccess.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  OriginalUpload.hasMany(VideoAccess, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  VideoAccess.belongsTo(OriginalUpload, {
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

  User.hasMany(StaticPage, {
    as: "UpdatedStaticPages",
    foreignKey: "updatedBy",
    onDelete: "SET NULL",
  });
  StaticPage.belongsTo(User, {
    as: "UpdatedByUser",
    foreignKey: "updatedBy",
    onDelete: "SET NULL",
  });

  User.hasMany(VideoTransferMapping, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  VideoTransferMapping.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  VideoTransferMapping.hasMany(VideoTransferHistory, {
    foreignKey: "mediacmsUserId",
    sourceKey: "mediacmsUserId",
    onDelete: "CASCADE",
  });
  VideoTransferHistory.belongsTo(VideoTransferMapping, {
    foreignKey: "mediacmsUserId",
    targetKey: "mediacmsUserId",
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
  EmailVerificationToken,
  UserApiKey,
  SsoProvider,
  UserIdentity,
  OriginalUpload,
  VideoMetadata,
  VideoThumbnail,
  TranscodeProfile,
  FileVersion,
  UserPlaylist,
  PlaylistItem,
  VideoLike,
  VideoAccess,
  ContentTag,
  FeaturedVideo,
  Subscription,
  Notification,
  UserNotificationSetting,
  StaticPage,
  SystemConfig,
  VideoTransferMapping,
  VideoTransferHistory,
};

export {
  ContentTag,
  EmailVerificationToken,
  FeaturedVideo,
  FileVersion,
  Notification,
  OriginalUpload,
  PlaylistItem,
  Role,
  SsoProvider,
  StaticPage,
  Subscription,
  SystemConfig,
  TranscodeProfile,
  User,
  UserApiKey,
  UserIdentity,
  UserNotificationSetting,
  UserPlaylist,
  VideoAccess,
  VideoLike,
  VideoMetadata,
  VideoThumbnail,
  VideoTransferHistory,
  VideoTransferMapping,
};

export { sequelize };
