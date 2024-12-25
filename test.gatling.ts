// import {
//   scenario,
//   rampUsers,
//   bodyString,
//   StringBody,
//   jsonPath
// } from "@gatling.io/core";
// import { http, HttpRequestActionBuilder, status } from "@gatling.io/http";

// const BASE_URL_ORDER = "http://localhost:4041";
// const BASE_URL_TRACK = "http://localhost:4043";
// const POST_ENDPOINT = "/api/v1/order";
// const GET_ORDER_ENDPOINT = "/api/v1/order/${orderId}";
// const GET_TRACK_ENDPOINT = "/api/v1/track/${trackerId}";
// const REQUEST_BODY =
//   '{ \"productId\": \"7d1f45d2-80d9-4ee0-a99d-ca180bd6d536\" }';

// export default {
//   setUp: (setUp) => {
//     const test = exec(
//       http("Post Order Request")
//         .post(`${BASE_URL_ORDER}${POST_ENDPOINT}`)
//         .header("Content-Type", "application/json")
//         .body(StringBody(REQUEST_BODY))
//         .check(
//           status().is(201), // Check if the status code is 201
//           jsonPath("$.orderId").saveAs("orderId") // Save the orderId
//         )
//     )
//       .pause(1, 3) // Wait for 1-3 seconds
//       .exec(
//         http("Get Order Request")
//           .get(`${BASE_URL_ORDER}${GET_ORDER_ENDPOINT}`)
//           .header("Content-Type", "application/json")
//           .check(
//             status().is(200),
//             jsonPath("$.trackerId").saveAs("trackerId") // Save the trackerId
//           )
//       )
//       .pause(1, 3) // Wait for 1 to 3 seconds
//       .exec(
//         http("Get Tracker Request")
//           .get(`${BASE_URL_TRACK}${GET_TRACK_ENDPOINT}`)
//           .header("Content-Type", "application/json")
//           .check(status().is(200))
//       );

//     // const httpProtocol = http
//     //   .baseUrl(BASE_URL_ORDER) // Use BASE_URL_ORDER as base URL
//     //   .acceptHeader(
//     //     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
//     //   )
//     //   .acceptLanguageHeader("en-US,en;q=0.5")
//     //   .acceptEncodingHeader("gzip, deflate")
//     //   .userAgentHeader(
//     //     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/119.0"
//     //   );

//     const testScenario = scenario("Test Scenario").exec(test);

//     setUp(
//       testScenario.injectOpen(
//         rampUsers(30).during(10) // Ramp up 30 users over 10 seconds
//       )
//     );
//   }
// };
// function exec(arg0: HttpRequestActionBuilder) {
//   throw new Error("Function not implemented.");
// }
