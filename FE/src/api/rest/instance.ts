import axios from 'axios';

const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_NODE1_URL ||
  'http://localhost:3000';

const axiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
});

axiosInstance.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// axiosInstance.interceptors.response.use(
//   (response) => {
//     if (response.status === 404) {
//       console.log('404 페이지로 이동');
//     }

//     return response;
//   },
//   async (error) => {
//     if (error.response?.status === 401) {
//       // isTokenExpired() - 토큰 만료 여부를 확인하는 함수
//       // tokenRefresh() - 토큰을 갱신해주는 함수
//       if (isTokenExpired()) await tokenRefresh();

//       const accessToken = getToken();

//       error.config.headers = {
//         'Content-Type': 'application/json',
//         Authorization: `Bearer ${accessToken}`
//       };

//       // 중단된 요청을(에러난 요청)을 토큰 갱신 후 재요청
//       const response = await axios.request(error.config);
//       return response;
//     }
//     return Promise.reject(error);
//   }
// );

export default axiosInstance;
