const [expectedPlatform, label] = process.argv.slice(2);

if (!expectedPlatform || !label) {
  throw new Error("Uso: node scripts/assert-platform.mjs <platform> <label>");
}

if (process.platform !== expectedPlatform) {
  console.error(
    `Este paquete debe construirse en ${label}. El backend Python y FFmpeg son binarios nativos; ` +
      `construirlo desde ${process.platform} generaria un instalador roto.`
  );
  process.exit(1);
}
