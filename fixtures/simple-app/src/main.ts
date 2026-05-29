import { messageForUser } from "./messages";

export function renderMessage(name: string) {
  return messageForUser(name).toUpperCase();
}

if (import.meta.main) {
  console.log(renderMessage("Specwright"));
}
