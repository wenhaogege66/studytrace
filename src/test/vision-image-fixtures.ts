// Synthetic 2x2 solid-color images, generated and decoded entirely in memory.
export const jpegImage =
  "data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKVAB//Z"
export const pngImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4AAYMEAoATs4LQaNgQ+cAAAAASUVORK5CYII="

export const invalidImages = [
  { name: "JPEG signature only", image: "data:image/jpeg;base64,/9j/2Q==" },
  { name: "PNG signature only", image: "data:image/png;base64,iVBORw0KGgo=" },
  {
    name: "JPEG missing scan data",
    image: `data:image/jpeg;base64,${Buffer.from(jpegImage.split(",")[1], "base64").subarray(0, -12).toString("base64")}`,
  },
  {
    name: "PNG truncated pixel data",
    image: `data:image/png;base64,${Buffer.concat([
      Buffer.from(pngImage.split(",")[1], "base64").subarray(0, 65),
      Buffer.from(pngImage.split(",")[1], "base64").subarray(-12),
    ]).toString("base64")}`,
  },
  {
    name: "JPEG missing end marker",
    image: `data:image/jpeg;base64,${Buffer.from(jpegImage.split(",")[1], "base64").subarray(0, -2).toString("base64")}`,
  },
  {
    name: "PNG missing end chunk",
    image: `data:image/png;base64,${Buffer.from(pngImage.split(",")[1], "base64").subarray(0, -12).toString("base64")}`,
  },
]
