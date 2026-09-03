import { sequelize } from "../db.js";
import { AccessPermission } from "./access-permission.js";
import { ApiKeyScope } from "./api-key-scope.js";
import { Comment } from "./comment.js";
import { ContentTag } from "./content-tag.js";
import { DuplicateUploadFlag } from "./duplicate-upload-flag.js";
import { EmailVerificationToken } from "./email-verification-token.js";
import { FeaturedVideo } from "./featured-video.js";
import { FileVersion } from "./file-version.js";
import { Livestream } from "./livestream.js";
import { Notification } from "./notification.js";
import { NotificationType } from "./notification-type.js";
import { OriginalUpload } from "./original-upload.js";
import { PasswordResetToken } from "./password-reset-token.js";
import { PlaylistAccess } from "./playlist-access.js";
import { PlaylistItem } from "./playlist-item.js";
import { Report } from "./report.js";
import { Role } from "./role.js";
import { SsoProvider } from "./sso-provider.js";
import { StaticPage } from "./static-page.js";
import { StreamKey } from "./stream-key.js";
import { Subscription } from "./subscription.js";
import { SystemConfig } from "./system-config.js";
import { Theme } from "./theme.js";
import { TranscodeProfile } from "./transcode-profile.js";
import { User } from "./user.js";
import { UserApiKey } from "./user-api-key.js";
import { UserApiKeyScope } from "./user-api-key-scope.js";
import { UserHiddenVideo } from "./user-hidden-video.js";
import { UserIdentity } from "./user-identity.js";
import { UserNotificationSetting } from "./user-notification-setting.js";
import { UserPlaylist } from "./user-playlist.js";
import { UserViewHistory } from "./user-view-history.js";
import { VideoAccess } from "./video-access.js";
import { VideoLike } from "./video-like.js";
import { VideoMetadata } from "./video-metadata.js";
import { VideoThumbnail } from "./video-thumbnail.js";
import { VideoSubtitle } from "./video-subtitle.js";
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

  Theme.hasMany(User, {
    foreignKey: "themeId",
    onDelete: "SET NULL",
  });
  User.belongsTo(Theme, {
    foreignKey: "themeId",
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

  UserApiKey.hasMany(UserApiKeyScope, {
    foreignKey: "userApiKeyId",
    onDelete: "CASCADE",
  });
  UserApiKeyScope.belongsTo(UserApiKey, {
    foreignKey: "userApiKeyId",
    onDelete: "CASCADE",
  });

  ApiKeyScope.hasMany(UserApiKeyScope, {
    foreignKey: "apiKeyScopeId",
  });
  UserApiKeyScope.belongsTo(ApiKeyScope, {
    foreignKey: "apiKeyScopeId",
  });

  User.hasOne(StreamKey, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  StreamKey.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  User.hasOne(Livestream, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  Livestream.belongsTo(User, {
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

  User.hasMany(PasswordResetToken, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  PasswordResetToken.belongsTo(User, {
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

  OriginalUpload.hasMany(VideoSubtitle, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  VideoSubtitle.belongsTo(OriginalUpload, {
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

  UserPlaylist.hasMany(PlaylistAccess, {
    foreignKey: "playlistId",
    onDelete: "CASCADE",
  });
  PlaylistAccess.belongsTo(UserPlaylist, {
    foreignKey: "playlistId",
    onDelete: "CASCADE",
  });

  User.hasMany(PlaylistAccess, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  PlaylistAccess.belongsTo(User, {
    foreignKey: "userId",
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

  User.hasMany(UserViewHistory, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  UserViewHistory.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  OriginalUpload.hasMany(UserViewHistory, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  UserViewHistory.belongsTo(OriginalUpload, {
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

  AccessPermission.hasMany(VideoAccess, {
    foreignKey: "permissionId",
  });
  
  VideoAccess.belongsTo(AccessPermission, {
    foreignKey: "permissionId",
  });

  AccessPermission.hasMany(PlaylistAccess, {
    foreignKey: "permissionId",
  });
  
  PlaylistAccess.belongsTo(AccessPermission, {
    foreignKey: "permissionId",
  });
  
  User.hasMany(UserHiddenVideo, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  
  UserHiddenVideo.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  OriginalUpload.hasMany(UserHiddenVideo, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  
  UserHiddenVideo.belongsTo(OriginalUpload, {
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

  OriginalUpload.hasMany(Comment, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });
  
  Comment.belongsTo(OriginalUpload, {
    foreignKey: "originalUploadId",
    onDelete: "CASCADE",
  });

  User.hasMany(Comment, {
    foreignKey: "userId",
    onDelete: "SET NULL",
  });
  
  Comment.belongsTo(User, {
    foreignKey: "userId",
    onDelete: "SET NULL",
  });

  Comment.hasMany(Comment, {
    as: "Replies",
    foreignKey: "parentCommentId",
    onDelete: "CASCADE",
  });
  Comment.belongsTo(Comment, {
    as: "ParentComment",
    foreignKey: "parentCommentId",
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

  NotificationType.hasMany(UserNotificationSetting, {
    foreignKey: "notificationTypeId",
    onDelete: "SET NULL",
  });
  UserNotificationSetting.belongsTo(NotificationType, {
    foreignKey: "notificationTypeId",
    onDelete: "SET NULL",
  });

  NotificationType.hasMany(Notification, {
    foreignKey: "notificationTypeId",
  });
  Notification.belongsTo(NotificationType, {
    foreignKey: "notificationTypeId",
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

  User.hasMany(Report, {
    as: "ReportsFiled",
    foreignKey: "reporterUserId",
    onDelete: "SET NULL",
  });
  Report.belongsTo(User, {
    as: "Reporter",
    foreignKey: "reporterUserId",
    onDelete: "SET NULL",
  });

  User.hasMany(Report, {
    as: "ReportsReceived",
    foreignKey: "reportedUserId",
    onDelete: "SET NULL",
  });
  Report.belongsTo(User, {
    as: "ReportedUser",
    foreignKey: "reportedUserId",
    onDelete: "SET NULL",
  });

  User.hasMany(Report, {
    as: "ReportComments",
    foreignKey: "commenterUserId",
    onDelete: "SET NULL",
  });
  Report.belongsTo(User, {
    as: "Commenter",
    foreignKey: "commenterUserId",
    onDelete: "SET NULL",
  });

  OriginalUpload.hasMany(Report, {
    foreignKey: "videoId",
    onDelete: "SET NULL",
  });
  Report.belongsTo(OriginalUpload, {
    foreignKey: "videoId",
    onDelete: "SET NULL",
  });

  UserPlaylist.hasMany(Report, {
    foreignKey: "playlistId",
    onDelete: "SET NULL",
  });
  Report.belongsTo(UserPlaylist, {
    foreignKey: "playlistId",
    onDelete: "SET NULL",
  });

  OriginalUpload.hasMany(DuplicateUploadFlag, {
    as: "DuplicateFlagsAsNew",
    foreignKey: "newOriginalUploadId",
    onDelete: "SET NULL",
  });
  DuplicateUploadFlag.belongsTo(OriginalUpload, {
    as: "NewUpload",
    foreignKey: "newOriginalUploadId",
    onDelete: "SET NULL",
  });

  OriginalUpload.hasMany(DuplicateUploadFlag, {
    as: "DuplicateFlagsAsExisting",
    foreignKey: "existingOriginalUploadId",
    onDelete: "SET NULL",
  });
  DuplicateUploadFlag.belongsTo(OriginalUpload, {
    as: "ExistingUpload",
    foreignKey: "existingOriginalUploadId",
    onDelete: "SET NULL",
  });

  User.hasMany(DuplicateUploadFlag, {
    as: "DuplicateFlagsModerated",
    foreignKey: "moderatorUserId",
    onDelete: "SET NULL",
  });
  DuplicateUploadFlag.belongsTo(User, {
    as: "Moderator",
    foreignKey: "moderatorUserId",
    onDelete: "SET NULL",
  });
}

registerAssociations();

/**
 * All registered Sequelize models for the application schema.
 *
 * @type {object}
 */
export const models = {
  AccessPermission,
  ApiKeyScope,
  Role,
  User,
  EmailVerificationToken,
  PasswordResetToken,
  UserApiKey,
  UserApiKeyScope,
  SsoProvider,
  UserIdentity,
  OriginalUpload,
  VideoMetadata,
  VideoThumbnail,
  VideoSubtitle,
  TranscodeProfile,
  FileVersion,
  UserPlaylist,
  PlaylistItem,
  PlaylistAccess,
  Report,
  DuplicateUploadFlag,
  VideoLike,
  VideoAccess,
  ContentTag,
  Comment,
  FeaturedVideo,
  Subscription,
  Notification,
  NotificationType,
  UserNotificationSetting,
  StaticPage,
  StreamKey,
  Livestream,
  SystemConfig,
  Theme,
  VideoTransferMapping,
  VideoTransferHistory,
  UserViewHistory,
  UserHiddenVideo,
};

export {
  AccessPermission,
  ApiKeyScope,
  Comment,
  ContentTag,
  DuplicateUploadFlag,
  EmailVerificationToken,
  FeaturedVideo,
  FileVersion,
  Livestream,
  Notification,
  NotificationType,
  OriginalUpload,
  PasswordResetToken,
  PlaylistAccess,
  PlaylistItem,
  Report,
  Role,
  SsoProvider,
  StaticPage,
  StreamKey,
  Subscription,
  SystemConfig,
  Theme,
  TranscodeProfile,
  User,
  UserApiKey,
  UserApiKeyScope,
  UserHiddenVideo,
  UserIdentity,
  UserNotificationSetting,
  UserPlaylist,
  UserViewHistory,
  VideoAccess,
  VideoLike,
  VideoMetadata,
  VideoSubtitle,
  VideoThumbnail,
  VideoTransferHistory,
  VideoTransferMapping,
};

export { sequelize };
