import { ensureSkillCognitionBootstrap } from "../dist/src/cognition-bootstrap.js";

const [groupId, groupName, userId, senderName, userRole, userRoleName] = process.argv.slice(2);

if (!groupId || !groupName || !userId || !senderName) {
  console.error("usage: node scripts/normalize-cognition.mjs <groupId> <groupName> <userId> <senderName> [userRole] [userRoleName]");
  process.exit(1);
}

const result = ensureSkillCognitionBootstrap({
  event: {
    id: `normalize-${Date.now()}`,
    event_type: "group_message",
    timestamp: Date.now(),
    data: {
      message_id: `normalize-${Date.now()}`,
      group_id: Number(groupId),
      group_name: groupName,
      user_role: Number(userRole ?? 0),
      user_role_name: userRoleName ?? "member",
      from_user_id: Number(userId),
      from_nickname: senderName,
      content: "",
      content_type: "text",
      timestamp: Date.now(),
    },
  },
  log: console.log,
  error: console.error,
});

console.log(JSON.stringify(result, null, 2));
