# PWA Kế Hoạch Công Việc — đồng bộ Google Drive

Thư mục này là một ứng dụng web tĩnh. Không cần chạy API, không cần Firebase và
không cần cơ sở dữ liệu trên máy chủ.

- Không đăng nhập: công việc nằm trong IndexedDB của trình duyệt hiện tại.
- Đăng nhập Google: ứng dụng hợp nhất dữ liệu vào
  `ke-hoach-cong-viec-sync.json` trong `appDataFolder` (vùng dữ liệu ẩn) của
  Google Drive cá nhân.
- PWA và ứng dụng desktop dùng chung định dạng:

```json
{
  "schema_version": 1,
  "updated_at": "2026-07-30T08:00:00.000Z",
  "tasks": []
}
```

Xung đột được xử lý theo `updated_at`; bản có thời điểm mới hơn được giữ.
Task đã xóa vẫn được đồng bộ dưới dạng tombstone có `deleted_at`.

## 1. Tạo đăng nhập Google miễn phí

1. Mở [Google Cloud Console](https://console.cloud.google.com/) và tạo Project.
2. Trong **APIs & Services > Library**, bật **Google Drive API**.
3. Cấu hình **OAuth consent screen**. Khi ứng dụng còn ở chế độ Testing, thêm
   email của người thử nghiệm vào **Test users**.
4. Vào **Credentials > Create credentials > OAuth client ID**.
5. Chọn loại **Web application**.
6. Thêm địa chỉ trang web vào **Authorized JavaScript origins**, ví dụ:
   - chạy thử: `http://localhost:8080`
   - GitHub Pages: `https://TEN_GITHUB.github.io`
   - Cloudflare Pages: `https://TEN_TRANG.pages.dev`
7. Sao chép Client ID, mở `config.js` và điền vào `googleClientId`.

OAuth Client ID của web không phải mật khẩu. Không đưa Client Secret, API key
riêng tư hoặc mật khẩu vào thư mục này.

Ứng dụng chỉ xin quyền `drive.appdata` và email: nó không đọc các file Drive
thông thường. Dữ liệu đồng bộ tối đa 5 MiB.

## 2. Chạy thử trên máy

Không mở trực tiếp `index.html` bằng `file://`, vì đăng nhập Google và service
worker cần một origin HTTP/HTTPS.

Từ thư mục `static`:

```powershell
python -m http.server 8080
```

Mở `http://localhost:8080`, tạo thử một công việc, nhấn biểu tượng tài khoản,
chọn **Đăng nhập với Google**, rồi nhấn **Đồng bộ**.

Để thử hai thiết bị/trình duyệt:

1. đăng nhập cùng một tài khoản Google ở cả hai;
2. thêm hoặc sửa công việc trên thiết bị thứ nhất và đồng bộ;
3. nhấn Đồng bộ trên thiết bị thứ hai;
4. kiểm tra việc mới xuất hiện và dữ liệu cục bộ vẫn còn sau khi đăng xuất.

## 3. Đưa lên hosting tĩnh miễn phí

### GitHub Pages

Đưa toàn bộ file trong thư mục này lên một repository, mở
**Settings > Pages**, chọn deploy từ branch. Sau khi có URL HTTPS, thêm origin
`https://TEN_GITHUB.github.io` vào OAuth Client ID trên Google Cloud.

### Cloudflare Pages

Kết nối repository với Cloudflare Pages. Không cần build command; đặt thư mục
output là thư mục chứa `index.html`. Sau khi deploy, thêm origin
`https://TEN_TRANG.pages.dev` vào OAuth Client ID.

Các đường dẫn trong PWA là tương đối nên có thể chạy ở tên miền gốc hoặc thư mục
con của GitHub Pages. Khi phát hành bản mới, tăng tên cache trong `sw.js` để các
thiết bị nhận shell mới.

## Cấu hình cập nhật

Trong `config.js`:

```js
window.KE_HOACH_CONFIG = {
  googleClientId: "CLIENT_ID_THAT.apps.googleusercontent.com",
  updateUrl: "https://dia-chi-trang-cap-nhat.example",
  version: "PWA 1.10"
};
```

`updateUrl` có thể để trống. PWA được cập nhật từ hosting khi service worker tải
bản mới; đường dẫn này chỉ dùng cho nút mở trang thông tin/tải phiên bản.
