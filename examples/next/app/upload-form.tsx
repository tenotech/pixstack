"use client";
import { prepareUpload } from "pixstack/client";
import { useActionState } from "react";
import { upload, type UploadState } from "./actions";

export function UploadForm() {
  const [state, action, pending] = useActionState(async (prev: UploadState, form: FormData) => {
    const file = form.get("image");
    // Shrink to 2560 px in the browser first: faster on mobile, same result on the server.
    if (file instanceof File && file.size > 0) form.set("image", (await prepareUpload(file)).file);
    return upload(prev, form);
  }, {});
  return (
    <form action={action} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input type="file" name="image" accept="image/*" required />
      <button disabled={pending}>{pending ? "Uploading…" : "Upload"}</button>
      {state.error && <span role="alert">{state.error}</span>}
    </form>
  );
}
