import Image from "next/image";
import { toImageRef } from "pixstack";
import { Img } from "pixstack/react";
import { allImages } from "../lib/images";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function Page() {
  const list = await allImages();
  const first = list[0];
  return (
    <main>
      <h1>pixstack + Next.js</h1>
      <UploadForm />
      {list.length === 0 && <p>No images yet.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginTop: 16 }}>
        {list.map((meta, i) => (
          // <Img>: AVIF + WebP srcset, width/height (no layout shift), thumbhash placeholder;
          // `priority` on the first one: eager, fetchpriority=high, preload in <head>.
          <Img
            key={meta.id}
            image={meta}
            alt=""
            sizes="(min-width: 768px) 25vw, 50vw"
            priority={i === 0}
            style={{ width: "100%", height: "auto" }}
          />
        ))}
      </div>
      {first && (
        <>
          <h2>The same image through next/image</h2>
          <p>With the pixstack loader (next.config.ts), each width maps to a stored WebP: no optimizer runs.</p>
          <Image
            src={toImageRef(first)}
            alt=""
            width={480}
            height={Math.round((480 * first.height) / first.width)}
            sizes="480px"
          />
        </>
      )}
    </main>
  );
}
