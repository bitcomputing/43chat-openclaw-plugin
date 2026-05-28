import { describe, expect, it } from "vitest";
import { extract43ChatTextContent } from "../message-content.js";

describe("43Chat message content extraction", () => {
  it("keeps text content as plain text", () => {
    expect(extract43ChatTextContent("你好！今天天气不错", "text")).toBe("你好！今天天气不错");
  });

  it("formats image content from the JSON url payload", () => {
    expect(
      extract43ChatTextContent("{\"url\":\"https://img.duiniu.cn/images/abc123.jpg\"}", "image"),
    ).toBe("[图片] https://img.duiniu.cn/images/abc123.jpg");
  });

  it("formats jg image content with dimensions from the latest event payload", () => {
    expect(
      extract43ChatTextContent(
        "{\"url\":\"https://img.duiniu.cn/43chat/20260509/3/12373_1778305924.jpg\",\"thumbnail\":\"https://img.duiniu.cn/43chat/20260509/3/12373_1778305924.jpg?x-oss-process=image/resize,w_200,h_200\",\"width\":1086,\"height\":1448,\"size\":2498199}",
        "jg:img",
      ),
    ).toBe("[图片] https://img.duiniu.cn/43chat/20260509/3/12373_1778305924.jpg 尺寸: 1086x1448");
  });

  it("formats file content from the JSON url payload", () => {
    expect(
      extract43ChatTextContent("{\"url\":\"https://img.duiniu.cn/files/document.pdf\"}", "file"),
    ).toBe("[文件] https://img.duiniu.cn/files/document.pdf");
  });

  it("formats file content with the file name when present", () => {
    expect(
      extract43ChatTextContent(
        "{\"name\":\"需求文档.pdf\",\"url\":\"https://img.duiniu.cn/files/document.pdf\"}",
        "file",
      ),
    ).toBe("[文件] 需求文档.pdf https://img.duiniu.cn/files/document.pdf");
  });

  it("formats shared group content from the JSON payload", () => {
    expect(
      extract43ChatTextContent(
        "{\"im_group_id\":\"GRP_123\",\"name\":\"技术交流群\",\"avatar\":\"https://example.com/a.png\",\"member_count\":50,\"description\":\"讨论技术问题\"}",
        "sharegroup",
      ),
    ).toBe("[分享群组] 技术交流群 (GRP_123) 成员: 50 描述: 讨论技术问题");
  });

  it("formats shared user cards from the JSON payload", () => {
    expect(
      extract43ChatTextContent(
        "{\"user_id\":12389,\"im_user_id\":\"prod_12389\",\"nickname\":\"白廷远\",\"avatar\":\"\",\"signature\":\"Open Platform Agent: 白廷远\"}",
        "shareuser",
      ),
    ).toBe("[分享用户] 白廷远 (prod_12389) 签名: Open Platform Agent: 白廷远");
  });
});
