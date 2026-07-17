const express = require("express");
const puppeteer = require("puppeteer");
const axios = require("axios");
const AdmZip = require("adm-zip");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// index.html 파일을 localhost:3000에서 바로 보여주도록 설정
app.use(express.static(__dirname));

app.post("/api/extract", async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith("https://1kuji.com")) {
    return res
      .status(400)
      .json({ error: "올바른 이치방쿠지 링크를 입력해주세요." });
  }

  let browser;
  try {
    // 1. Puppeteer로 가상 브라우저 실행 (headless 모드)
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // 이치방쿠지 사이트 접속 및 네트워크 안정화 대기
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 2. 브라우저 콘솔에서 피규어 원본 이미지 링크만 추출
    const imageUrls = await page.evaluate(() => {
      const images = Array.from(document.querySelectorAll("img"));
      const targets = images.filter((img) => {
        const alt = img.getAttribute("alt") || "";
        const src = img.src || img.getAttribute("src") || "";
        return alt === "img1" || src.includes("product_item/image");
      });

      // 중복 제거 및 절대 경로 확보
      return [...new Set(targets.map((img) => img.src))];
    });

    await browser.close();

    if (imageUrls.length === 0) {
      return res
        .status(404)
        .json({ error: "추출할 피규어 이미지를 찾지 못했습니다." });
    }

    // 3. 수집된 이미지들을 메모리 상에서 다운로드하여 ZIP 압축
    const zip = new AdmZip();

    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      try {
        const response = await axios.get(imgUrl, {
          responseType: "arraybuffer",
        });
        const buffer = Buffer.from(response.data, "binary");
        // 파일명 지정 (figure_1.webp, figure_2.webp ...)
        zip.addFile(`figure_${i + 1}.webp`, buffer);
      } catch (err) {
        console.error(`이미지 다운로드 실패: ${imgUrl}`, err.message);
      }
    }

    // 4. 생성된 ZIP 파일을 클라이언트에게 즉시 전송
    // URL 파싱하여 파일명 동적 생성 (예: myhero44)
    const urlParts = url.split("/").filter((part) => part.length > 0);
    const filename =
      urlParts.length > 0 ? urlParts[urlParts.length - 1] : "ichibankuji";

    const zipBuffer = zip.toBuffer();
    res.set({
      "Content-Type": "application/zip",
      // 응답 헤더의 파일명도 동적으로 변경해 줍니다.
      "Content-Disposition": `attachment; filename="${filename}.zip"`,
      "Content-Length": zipBuffer.length,
    });

    return res.send(zipBuffer);
  } catch (error) {
    if (browser) await browser.close();
    console.error(error);
    return res.status(500).json({ error: "서버 에러가 발생했습니다." });
  }
});

// 기존 app.listen(3000, ...) 부분을 아래처럼 변경
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
