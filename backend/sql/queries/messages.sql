-- name: CreateMessage :one
INSERT INTO messages (chat_id, sender_id, content, reply_to_message_id)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: AddMessageImage :exec
INSERT INTO images (message_id, url)
VALUES ($1, $2);

-- name: GetMessagesByChat :many
SELECT
    m.id,
    m.chat_id,
    m.sender_id,
    m.content,
    m.is_deleted,
    m.is_edited,
    m.reply_to_message_id,
    m.created_at,
    m.updated_at,
    u.username as sender_username,
    u.profile_image_url as sender_profile_image_url,
    rm.content AS reply_content,
    rm.is_deleted AS reply_is_deleted,
    rm.sender_id AS reply_sender_id,
    ru.username AS reply_sender_username,
    ru.profile_image_url AS reply_sender_profile_image_url
FROM messages m
INNER JOIN users u ON m.sender_id = u.id
LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
LEFT JOIN users ru ON rm.sender_id = ru.id
WHERE m.chat_id = $1
ORDER BY m.created_at ASC
LIMIT 50;

-- name: GetMessagesByChatPaginated :many
SELECT
    m.id,
    m.chat_id,
    m.sender_id,
    m.content,
    m.is_deleted,
    m.is_edited,
    m.reply_to_message_id,
    m.created_at,
    m.updated_at,
    u.username as sender_username,
    u.profile_image_url as sender_profile_image_url,
    rm.content AS reply_content,
    rm.is_deleted AS reply_is_deleted,
    rm.sender_id AS reply_sender_id,
    ru.username AS reply_sender_username,
    ru.profile_image_url AS reply_sender_profile_image_url
FROM messages m
INNER JOIN chat_members cm_filter ON cm_filter.chat_id = m.chat_id AND cm_filter.user_id = sqlc.arg(user_id)::uuid
INNER JOIN users u ON m.sender_id = u.id
LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
LEFT JOIN users ru ON rm.sender_id = ru.id
WHERE m.chat_id = sqlc.arg(chat_id)::uuid
  AND (cm_filter.cleared_at IS NULL OR m.created_at > cm_filter.cleared_at)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL OR
    m.created_at < sqlc.narg(cursor_time)::timestamptz OR
    (m.created_at = sqlc.narg(cursor_time)::timestamptz AND m.id < sqlc.narg(cursor_id)::uuid)
  )
ORDER BY m.created_at DESC, m.id DESC
LIMIT sqlc.arg(page_limit);

-- name: GetMessageImages :many
SELECT id, message_id, url, created_at
FROM images
WHERE message_id = ANY($1::uuid[]);

-- name: DeleteMessage :exec
UPDATE messages
SET is_deleted = true, updated_at = CURRENT_TIMESTAMP
WHERE id = $1;

-- name: EditMessage :one
UPDATE messages
SET content = $2, is_edited = true, updated_at = CURRENT_TIMESTAMP
WHERE id = $1
RETURNING updated_at;

-- name: GetMessageById :one
SELECT
    m.id,
    m.chat_id,
    m.sender_id,
    m.content,
    m.is_deleted,
    m.is_edited,
    m.reply_to_message_id,
    m.created_at,
    m.updated_at
FROM messages m
WHERE m.id = $1;

-- name: DeleteMessageImages :exec
DELETE FROM images
WHERE message_id = $1 AND url = ANY($2::text[]);

-- name: DeleteImageByUrl :exec
DELETE FROM images
WHERE url = $1;

-- name: GetChatImageUrls :many
SELECT i.url
FROM images i
INNER JOIN messages m ON i.message_id = m.id
WHERE m.chat_id = $1;

-- name: UpsertChatReadReceipt :exec
INSERT INTO chat_read_receipts (chat_id, user_id, last_read_message_id, last_read_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (chat_id, user_id) DO UPDATE
SET
    last_read_message_id = CASE
        WHEN chat_read_receipts.last_read_at <= excluded.last_read_at THEN excluded.last_read_message_id
        ELSE chat_read_receipts.last_read_message_id
    END,
    last_read_at = GREATEST(chat_read_receipts.last_read_at, excluded.last_read_at);

-- name: GetChatReadReceipts :many
SELECT chat_id, user_id, last_read_message_id, last_read_at
FROM chat_read_receipts
WHERE chat_id = $1;
