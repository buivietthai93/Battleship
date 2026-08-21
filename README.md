# Hải Chiến.io — Game bắn thuyền (Battleship) trực tuyến

Game bắn thuyền 1 chọi 1, chơi thời gian thực qua mạng, có hệ thống tài khoản
(đăng ký/đăng nhập) và lưu lại số trận thắng/thua.

## Công nghệ sử dụng

- **Backend:** Node.js, Express, Socket.IO (real-time), lưu tài khoản bằng file
  JSON đơn giản (không cần cài database, không cần trình biên dịch C++)
- **Xác thực:** JWT (JSON Web Token) + mật khẩu băm bằng `bcryptjs`
- **Frontend:** HTML/CSS/JavaScript thuần (không cần build, không cần framework)

## Tính năng

- Đăng ký / đăng nhập tài khoản, hoặc chơi thử với tư cách khách
- Ghép trận tự động: bấm "Tìm trận" là được nối với người chơi khác đang chờ
- Bố trí hạm đội 5 tàu theo đúng luật Battleship cổ điển (server luôn kiểm tra
  lại vị trí tàu để tránh gian lận từ phía client)
- Bắn theo lượt thời gian thực, có nhật ký giao tranh, báo khi đánh chìm tàu
- Lưu số trận thắng/thua vào cơ sở dữ liệu cho tài khoản đã đăng ký

## Chạy thử trên máy của bạn

Yêu cầu: đã cài [Node.js](https://nodejs.org) bản 18 trở lên.

```bash
# 1. Giải nén / vào thư mục dự án
cd battleship-io

# 2. Cài thư viện
npm install

# 3. (Tuỳ chọn) tạo file .env để đổi khoá bí mật JWT
cp .env.example .env
# rồi mở file .env sửa JWT_SECRET thành một chuỗi ngẫu nhiên dài

# 4. Chạy server
npm start
```

Sau đó mở trình duyệt vào `http://localhost:3000`. Mở 2 tab (hoặc 2 trình
duyệt khác nhau) để tự chơi thử với chính mình.

Dữ liệu tài khoản được lưu trong file `data.json` ngay trong thư mục dự án —
không cần cài đặt database riêng, không cần trình biên dịch C++/Visual Studio.

## Đưa lên internet để người khác chơi cùng (deploy)

Vì đây là ứng dụng có server thật (không phải chỉ HTML tĩnh), bạn cần một nơi
host hỗ trợ chạy Node.js liên tục. Vài lựa chọn phổ biến, có gói miễn phí:

### Cách 1: Render.com (khuyến nghị, dễ nhất)

1. Đưa code lên một repository GitHub (tạo repo mới, `git push`).
2. Vào [render.com](https://render.com) → **New** → **Web Service** → chọn
   repo GitHub của bạn.
3. Cấu hình:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Vào tab **Environment**, thêm biến `JWT_SECRET` với một chuỗi ngẫu nhiên
   dài (đừng dùng giá trị mặc định trong `.env.example`).
5. Bấm **Create Web Service**. Render sẽ cấp cho bạn một địa chỉ dạng
   `https://ten-app-cua-ban.onrender.com` — gửi link này cho bạn bè là chơi
   được.

> Lưu ý: gói miễn phí của Render sẽ "ngủ" sau một thời gian không có ai
> truy cập, nên lần vào đầu tiên có thể mất vài giây để server thức dậy.
> Ổ đĩa của gói miễn phí cũng không lưu trữ vĩnh viễn — nếu cần lưu tài
> khoản lâu dài, nên nâng cấp lên gói có "persistent disk" hoặc chuyển sang
> dùng PostgreSQL (xem phần "Nâng cấp" bên dưới).

### Cách 2: Railway.app

1. Đưa code lên GitHub như trên.
2. Vào [railway.app](https://railway.app) → **New Project** → **Deploy from
   GitHub repo**.
3. Railway tự nhận diện Node.js, tự chạy `npm install` và `npm start`.
4. Vào tab **Variables**, thêm `JWT_SECRET`.
5. Railway cấp một domain public, hoặc bạn có thể gắn tên miền riêng.

### Cách 3: VPS riêng (DigitalOcean, Vultr, v.v.)

1. Cài Node.js 18+ trên server.
2. Copy toàn bộ thư mục `battleship-io` lên server (qua `scp` hoặc `git clone`).
3. `npm install`, tạo file `.env` với `JWT_SECRET` riêng.
4. Dùng [`pm2`](https://pm2.keymetrics.io/) để chạy nền và tự khởi động lại
   khi crash:
   ```bash
   npm install -g pm2
   pm2 start server/index.js --name battleship
   pm2 save
   pm2 startup
   ```
5. Dùng Nginx làm reverse proxy + cấp SSL miễn phí bằng Certbot nếu muốn có
   `https://` và tên miền riêng.

## Cấu trúc thư mục

```
battleship-io/
├── package.json
├── .env.example        # copy thành .env, chỉnh JWT_SECRET
├── server/
│   ├── index.js         # server chính: Express + Socket.IO + ghép trận
│   ├── auth.js           # API đăng ký / đăng nhập / lấy thông tin tài khoản
│   ├── db.js              # lưu/đọc tài khoản trong file data.json
│   └── game.js            # luật đặt tàu, kiểm tra hợp lệ
├── public/                # toàn bộ giao diện (được phục vụ tĩnh)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── data.json               # tự tạo khi chạy lần đầu — chứa tài khoản người dùng
```

## Nâng cấp gợi ý cho tương lai

Bản hiện tại đã chạy đầy đủ và có thể deploy dùng ngay, nhưng nếu muốn phát
triển thêm, một vài hướng mở rộng tự nhiên:

- **Kết nối lại khi rớt mạng:** hiện tại nếu một người mất kết nối giữa
  trận, trận đấu bị huỷ. Có thể lưu trạng thái trận theo `userId` để cho
  phép người chơi load lại trang và vào lại đúng trận đang chơi dở.
- **Nhiều server cùng lúc:** trạng thái hàng chờ/phòng đang lưu trong bộ nhớ
  (RAM) của 1 server. Nếu lượng người chơi lớn cần chạy nhiều server, nên
  chuyển sang lưu trạng thái trong Redis.
- **Database thật thay vì file JSON:** file `data.json` phù hợp cho quy mô
  nhỏ/vừa. Nếu host không hỗ trợ ổ đĩa lưu trữ lâu dài (như gói miễn phí của
  một số nền tảng), hoặc lượng tài khoản lớn lên, nên chuyển sang database
  có server riêng như PostgreSQL (ví dụ dùng Supabase hoặc Neon, đều có gói
  miễn phí).
- **Bảng xếp hạng (leaderboard)**, **phòng chơi riêng bằng mã phòng** cho
  bạn bè hẹn nhau vào chung, **chat trong trận**, **chế độ chơi với máy
  (AI)** khi không tìm được đối thủ.
