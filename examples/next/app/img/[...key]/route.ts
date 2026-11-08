import { createImageHandler } from "pixstack/server";
import { storage } from "../../../lib/images";

// URL /img/<id>/<w>.<fmt> → storage key img/<id>/<w>.<fmt>, immutable caching, ETag, Range.
const handler = createImageHandler({ storage });
export { handler as GET, handler as HEAD };
