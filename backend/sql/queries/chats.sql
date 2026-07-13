-- name: SearchUsers :many
SELECT id, username, profile_image_url, created_at, updated_at
FROM users
WHERE username ILIKE '%' || sqlc.arg(query) || '%'
AND id != ALL(sqlc.arg(excluded_ids)::uuid[])
LIMIT 20;

-- name: CreateChat :one
INSERT INTO chats (name, is_group, created_by)
VALUES ($1, $2, $3)
RETURNING *;

-- name: AddChatMember :exec
INSERT INTO chat_members (chat_id, user_id)
VALUES ($1, $2);

-- name: GetChatByMembers :one
SELECT c.id, c.name, c.is_group, c.created_by, c.created_at, c.updated_at
FROM chats c
WHERE c.is_group = false
AND c.id IN (
    SELECT cm.chat_id
    FROM chat_members cm
    WHERE cm.user_id = ANY(sqlc.arg(member_ids)::uuid[])
    GROUP BY cm.chat_id
    HAVING COUNT(DISTINCT cm.user_id) = sqlc.arg(member_count)::bigint
    AND ARRAY_AGG(cm.user_id ORDER BY cm.user_id) = sqlc.arg(member_ids)
)
LIMIT 1;

-- name: GetChatByIdWithMembers :many
SELECT
    c.id as chat_id,
    c.name as chat_name,
    c.is_group,
    c.created_by,
    c.created_at as chat_created_at,
    c.updated_at as chat_updated_at,
    u.id as member_id,
    u.username as member_username,
    u.profile_image_url as member_profile_image_url
FROM chats c
INNER JOIN chat_members cm ON c.id = cm.chat_id
INNER JOIN users u ON cm.user_id = u.id
WHERE c.id = $1
ORDER BY u.username ASC;

-- name: GetChatsWithMembers :many
WITH user_chats AS (
    SELECT
        c.id as chat_id,
        c.name as chat_name,
        c.is_group,
        c.created_by,
        c.created_at,
        c.updated_at,
        cm_user.deleted_at as user_deleted_at,
        cm_user.cleared_at as user_cleared_at,
        lm.id as msg_id,
        lm.content as msg_content,
        lm.sender_id as msg_sender_id,
        lm.is_deleted as msg_is_deleted,
        lm.created_at as msg_created_at,
        sender.username as msg_sender_username,
        sender.profile_image_url as msg_sender_profile_image_url,
        COALESCE(unread_counts.unread_count, 0) as unread_count,
        ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY COALESCE(lm.created_at, c.created_at) DESC) as rn
    FROM chats c
    INNER JOIN chat_members cm_user ON c.id = cm_user.chat_id AND cm_user.user_id = $1
    LEFT JOIN LATERAL (
        SELECT id, chat_id, sender_id, content, is_deleted, created_at
        FROM messages
        WHERE chat_id = c.id
          AND (cm_user.cleared_at IS NULL OR created_at > cm_user.cleared_at)
        ORDER BY created_at DESC
        LIMIT 1
    ) lm ON true
    LEFT JOIN users sender ON lm.sender_id = sender.id
    LEFT JOIN chat_read_receipts cr ON cr.chat_id = c.id AND cr.user_id = $1
    LEFT JOIN LATERAL (
        SELECT COUNT(*) as unread_count
        FROM messages m
        WHERE m.chat_id = c.id
          AND m.sender_id <> $1
          AND (
            cr.last_read_at IS NULL
            OR m.created_at > cr.last_read_at
            OR (m.created_at = cr.last_read_at AND m.id <> cr.last_read_message_id)
          )
    ) unread_counts ON true
)
SELECT
    uc.chat_id,
    uc.chat_name,
    uc.is_group,
    uc.created_by,
    uc.created_at as chat_created_at,
    uc.updated_at as chat_updated_at,
    u.id as member_id,
    u.username as member_username,
    u.profile_image_url as member_profile_image_url,
    COALESCE(uc.msg_id, '00000000-0000-0000-0000-000000000000'::uuid) as last_message_id,
    uc.msg_content as last_message_content,
    COALESCE(uc.msg_sender_id, '00000000-0000-0000-0000-000000000000'::uuid) as last_message_sender_id,
    COALESCE(uc.msg_is_deleted, false) as last_message_is_deleted,
    COALESCE(uc.msg_created_at, uc.created_at) as last_message_created_at,
    uc.msg_sender_username as last_message_sender_username,
    uc.msg_sender_profile_image_url as last_message_sender_profile_image_url,
    uc.unread_count
FROM user_chats uc
INNER JOIN chat_members cm ON uc.chat_id = cm.chat_id
INNER JOIN users u ON cm.user_id = u.id
WHERE uc.rn = 1
  AND (uc.user_deleted_at IS NULL OR (uc.msg_created_at IS NOT NULL AND uc.msg_created_at > uc.user_deleted_at))
ORDER BY COALESCE(uc.msg_created_at, uc.created_at) DESC, u.username ASC;

-- name: GetLastMessageImages :many
SELECT message_id, url
FROM images
WHERE message_id = ANY($1::uuid[]);

-- name: GetChatMember :one
SELECT id, chat_id, user_id, joined_at, cleared_at, deleted_at
FROM chat_members
WHERE chat_id = $1 AND user_id = $2;

-- name: UpdateChatMemberClearedAt :exec
UPDATE chat_members
SET cleared_at = CURRENT_TIMESTAMP
WHERE chat_id = $1 AND user_id = $2;

-- name: UpdateChatMemberDeletedAt :exec
UPDATE chat_members
SET deleted_at = CURRENT_TIMESTAMP,
    cleared_at = CURRENT_TIMESTAMP
WHERE chat_id = $1 AND user_id = $2;

-- name: RemoveChatMember :exec
DELETE FROM chat_members
WHERE chat_id = $1 AND user_id = $2;

-- name: GetChatDeletionStats :one
SELECT
    COUNT(*)::int AS member_count,
    COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS deleted_count
FROM chat_members
WHERE chat_id = $1;

-- name: UpdateChatName :exec
UPDATE chats
SET name = $2,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1;

-- name: UpdateChatCreator :exec
UPDATE chats
SET created_by = $2,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1;

-- name: DeleteChat :exec
DELETE FROM chats
WHERE id = $1;

-- name: GetChatMetadata :one
SELECT id, name, is_group, created_by, created_at, updated_at
FROM chats
WHERE id = $1;
