/**
 * Word lists for the rule-based entity recognizer. Given names and surnames are common entries of the US Social
 * Security Administration baby-name lists and the US Census surname list (US government works, public domain).
 * Places are country, US state and well-known city names. Lists are kept small: the rules report names only with a
 * cue, and these lists only raise or lower a score.
 */

const words = (text: string): string[] => text.trim().split(/\s+/);

export const GIVEN_NAMES: ReadonlySet<string> = new Set(
  words(`
  James Mary Robert Patricia John Jennifer Michael Linda David Elizabeth William Barbara Richard Susan Joseph Jessica
  Thomas Sarah Charles Karen Christopher Lisa Daniel Nancy Matthew Betty Anthony Margaret Mark Sandra Donald Ashley
  Steven Kimberly Paul Emily Andrew Donna Joshua Michelle Kenneth Carol Kevin Amanda Brian Dorothy George Melissa
  Timothy Deborah Ronald Stephanie Edward Rebecca Jason Sharon Jeffrey Laura Ryan Cynthia Jacob Kathleen Gary Amy
  Nicholas Angela Eric Shirley Jonathan Anna Stephen Brenda Larry Pamela Justin Emma Scott Nicole Brandon Helen
  Benjamin Samantha Samuel Katherine Gregory Christine Alexander Debra Frank Rachel Patrick Carolyn Raymond Janet
  Jack Catherine Dennis Maria Jerry Heather Tyler Diane Aaron Ruth Jose Julie Adam Olivia Nathan Joyce Henry Virginia
  Douglas Victoria Zachary Kelly Peter Lauren Kyle Christina Ethan Joan Walter Evelyn Noah Judith Jeremy Megan
  Christian Andrea Keith Cheryl Roger Hannah Terry Jacqueline Gerald Martha Harold Gloria Sean Teresa Austin Ann
  Carl Sara Arthur Madison Lawrence Frances Dylan Kathryn Jesse Janice Jordan Jean Bryan Abigail Billy Alice Joe
  Judy Bruce Sophia Gabriel Grace Logan Denise Albert Amber Willie Doris Alan Marilyn Juan Danielle Wayne Beverly
  Elijah Isabella Randy Theresa Roy Diana Vincent Natalie Ralph Brittany Eugene Charlotte Russell Marie Bobby Kayla
  Mason Alexis Philip Lori Louis Liam Ava Mia Lucas Amelia Oliver Harper Elijah Evelyn Aiden Ella Carter Chloe
  Luke Zoe Owen Lily Wyatt Layla Leo Nora Isaac Riley Ezra Aria Hudson Ellie Caleb Stella Hunter Lucy Connor Paisley
  Eli Leah Ian Audrey Adrian Claire Asher Skylar Nolan Violet Dominic Aurora Miles Hazel Jaxon Savannah Rose May
  Will Jane Tom Tim Jim Bob Sam Ben Max Alex Kate Beth Liz Meg Pat Chris Nick Mike Dave Steve Matt Dan Rob Tony
  Ahmed Mohammed Muhammad Ali Fatima Aisha Omar Hassan Priya Raj Ravi Anil Sunita Wei Li Chen Yuki Hiroshi Kenji
  Carlos Miguel Luis Jorge Ana Sofia Lucia Pedro Diego Javier Elena Hans Klaus Jürgen Anna Lena Pierre Jean Marie
  Camille Louise Hugo Lukas Felix Paul Emma Lea Giulia Marco Luca Francesca Sven Lars Ingrid Olga Ivan Dmitri
  `)
);

export const SURNAMES: ReadonlySet<string> = new Set(
  words(`
  Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson
  Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker
  Young Allen King Wright Scott Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell
  Carter Roberts Gomez Phillips Evans Turner Diaz Parker Cruz Edwards Collins Reyes Stewart Morris Morales Murphy
  Cook Rogers Gutierrez Ortiz Morgan Cooper Peterson Bailey Reed Kelly Howard Ramos Kim Cox Ward Richardson Watson
  Brooks Chavez Wood James Bennett Gray Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross
  Foster Jimenez Powell Jenkins Perry Russell Sullivan Bell Coleman Butler Henderson Barnes Gonzales Fisher
  Vasquez Simmons Romero Jordan Patterson Alexander Hamilton Graham Reynolds Griffin Wallace Moreno West Cole
  Hayes Bryant Herrera Gibson Ellis Tran Medina Aguilar Stevens Murray Ford Castro Marshall Owens Harrison Fernandez
  McDonald Woods Washington Kennedy Wells Vargas Henry Chen Freeman Webb Tucker Guzman Burns Crawford Olson Simpson
  Porter Hunter Gordon Mendez Silva Shaw Snyder Mason Dixon Munoz Hunt Hicks Holmes Palmer Wagner Black Robertson
  Boyd Rose Stone Salazar Fox Warren Mills Meyer Rice Schmidt Garza Daniels Ferguson Nichols Stephens Soto Weaver
  Ryan Gardner Payne Grant Dunn Kelley Spencer Hawkins Arnold Pierce Hansen Peters Santos Hart Bradley Knight
  Elliott Cunningham Duncan Armstrong Hudson Carroll Lane Riley Andrews Ray Berry Perkins Hoffman Johnston Matthews
  Pena Richards Willis Carpenter Lawrence Sandoval Guerrero George Chapman Rios Estrada Ortega Watkins Greene
  Nunez Wheeler Valdez Harper Burke Larson Santiago Maldonado Morrison Franklin Carlson Austin Dominguez Carr
  Lawson Jacobs OBrien O'Brien Lynch Singh Vega Bishop Montgomery Oliver Jensen Harvey Williamson Gilbert Dean
  Sims Espinoza Howell Li Wong Reid Hanson Le McCoy Garrett Burton Fuller Wang Weber Welch Rojas Lucas Marquez
  Fields Park Yang Little Banks Padilla Day Walsh Bowman Schultz Luna Fowler Mejia Davidson Acosta Brewer May
  Holland Juarez Newman Pearson Curtis Cortez Douglas Schneider Joseph Barrett Navarro Figueroa Keller Avila Wade
  Molina Stanley Hopkins Campos Barnett Bates Chambers Caldwell Beck Lambert Miranda Byrd Craig Ayala Lowe Frazier
  Powers Neal Leonard Gregory Carrillo Sutton Fleming Rhodes Shelton Schwartz Norris Jennings Watts Duran Walters
  Cohen McDaniel Moran Parks Steele Vaughn Becker Holt Deleon Barker Terry Hale Leon Hail Benson Haynes Horton
  Miles Lyons Pham Graves Bush Thornton Wolfe Warner Cabrera McKinney Mann Zimmerman Dawson Lara Fletcher Page
  McCarthy Love Robles Cervantes Solis Erickson Reeves Chang Klein Salinas Fuentes Baldwin Daniel Simon Velasquez
  Hardy Higgins Aguirre Lin Cummings Chandler Sharp Barber Bowen Ochoa Dennis Robbins Liu Ramsey Francis Griffith
  Paul Blair OConnor O'Connor Cardenas Pacheco Cross Calderon Quinn Moss Swanson Chan Rivas Khan Rodgers Serrano
  Fitzgerald Rosales Stevenson Christensen Manning Gill Curry McLaughlin Harmon McGee Gross Doyle Garner Newton
  Burgess Reese Walton Blake Trujillo Adkins Brady Goodman Roman Webster Goodwin Fischer Huang Potter Delacruz
  Montoya Todd Wu Hines Mullins Castaneda Malone Cannon Tate Mack Sherman Hubbard Hodges Zhang Guerra Wolf Valencia
  Saunders Franco Rowe Gallagher Farmer Hammond Hampton Townsend Ingram Wise Gallegos Clarke Barton Schroeder
  Maxwell Waters Logan Camacho Strickland Norman Person Colon Parsons Frank Harrington Glover Osborne Buchanan
  Casey Floyd Patton Ibarra Ball Tyler Suarez Bowers Orozco Salas Cobb Gibbs Andrade Bauer Conner Moody Escobar
  McGuire Lloyd Mueller Hartman French Kramer McBride Pope Lindsey Velazquez Norton McCormick Sparks Flynn Yates
  Hogan Marsh Macias Villanueva Zamora Pratt Stokes Owen Ballard Lang Brock Villarreal Charles Drake Barrera Cain
  Patrick Pineda Burnett Mercado Santana Shepherd Bautista Ali Shaffer Lamb Trevino McKenzie Hess Beil Olsen
  Cochran Morton Nash Wilkins Petersen Briggs Shah Roth Nicholson Holloway Lozano Rangel Flowers Hoover Short
  Arias Mora Valenzuela Bryan Meyers Weiss Underwood Bass Greer Summers Houston Carson Morrow Clayton Whitaker
  Decker Yoder Collier Zuniga Carey Wilcox Melendez Poole Roberson Larsen Conley Davenport Copeland Massey Lam
  Huff Rocha Cameron Jefferson Hood Monroe Anthony Pittman Huynh Randall Singleton Kirk Combs Mathis Christian
  Skinner Bradford Richard Galvan Wall Boone Kirby Wilkinson Bridges Bruce Atkinson Velez Meza Roy Vincent York
  Hodge Villa Abbott Allison Tapia Gates Chase Sosa Sweeney Farrell Wyatt Dalton Horn Barron Phelps Yu Dickerson
  Heath Foley Atkins Mathews Bonilla Acevedo Benitez Zavala Hensley Glenn Cisneros Harrell Shields Rubio Huffman
  Choi Boyer Garrison Arroyo Bond Kane Hancock Callahan Dillon Cline Wiggins Grimes Arellano Melton O'Neill
  Savage Ho Beltran Pitts Parrish Ponce Rich Booth Koch Golden Ware Brennan McDowell Marks Cantu Humphrey Baxter
  Sawyer Clay Tanner Hutchinson Kaur Berg Wiley Gilmore Russo Villegas Hobbs Keith Wilkerson Ahmed Beard McClain
  Montes Mata Rosario Vang Walter Henson Oneal Mosley McClure Beasley Stephenson Snow Huerta Preston Vance Barry
  Johns Eaton Blackwell Dyer Prince Macdonald Solomon Guevara Stafford English Hurst Woodard Cortes Shannon Kemp
  Nolan McCullough Merritt Murillo Moon Salgado Strong Kline Cordova Barajas Roach Rosas Winters Jacobson Lester
  Knox Bullock Kerr Leach Meadows Davila Orr Whitehead Pruitt Kent Conway McKee Barr David Dejesus Marin Berger
  McIntyre Blankenship Gaines Palacios Cuevas Bartlett Durham Dorsey McCall O'Donnell Stein Browning Stout Lowery
  Sloan McLean Hendricks Calhoun Sexton Chung Gentry Hull Duarte Ellison Nielsen Gillespie Buck Middleton Sellers
  Leblanc Esparza Hardin Bradshaw McIntosh Howe Livingston Frost Glass Morse Knapp Herman Stark Bravo Noble
  Spears Weeks Corona Frederick Buckley McFarland Hebert Enriquez Hickman Quintero Randolph Schaefer Walls Trejo
  House Reilly Pennington Michael Conrad Giles Benjamin Crosby Fitzpatrick Donovan Mays Mahoney Valentine Raymond
  Medrano Hahn McMillan Small Bentley Felix Peck Lucero Boyle Hanna Pace Rush Hurley Harding McConnell Bernal
  Nava Ayers Everett Ventura Avery Pugh Mayer Bender Shepard McMahon Landry Case Sampson Moses Magana Blackburn
  Dunlap Gould Duffy Vaughan Herring McKay Espinosa Rivers Farley Bernard Ashley Friedman Potts Truong Costa
  Correa Blevins Nixon Clements Fry Delarosa Best Benton Lugo Portillo Dougherty Crane Haley Phan Villalobos
  Blanchard Horne Finley Quintana Lynn Esquivel Bean Dodson Mullen Xiong Hayden Cano Levy Huber Richmond Moyer
  Lim Frye Sheppard McCarty Avalos Booker Waller Parra Woodward Jaramillo Krueger Rasmussen Brandt Peralta
  Donaldson Stuart Faulkner Maynard Galindo Coffey Estes Sanford Burch Maddox Vo O'Connell Vu Andersen Spence
  McPherson Church Schmitt Stanton Leal Cherry Compton Dudley Sierra Pollard Alfaro Hester Proctor Lu Hinton Novak
  Good Madden McCann Terrell Jarvis Dickson Reyna Cantrell Mayo Branch Hendrix Rollins Rowland Whitney Duke Odom
  Daugherty Travis Tang Archer Müller Schmidt Schneider Fischer Weber Meyer Wagner Becker Schulz Hoffmann Koch
  Richter Klein Wolf Schröder Neumann Schwarz Zimmermann Braun Krüger Hofmann Hartmann Lange Werner Krause
  Martin Bernard Dubois Thomas Robert Richard Petit Durand Leroy Moreau Simon Laurent Lefebvre Michel Garcia
  David Bertrand Roux Vincent Fournier Morel Girard Andre Lefevre Mercier Dupont Lambert Bonnet Francois Martinez
  Rossi Russo Ferrari Esposito Bianchi Romano Colombo Ricci Marino Greco Bruno Gallo Conti Costa Giordano Mancini
  Tanaka Suzuki Takahashi Watanabe Ito Yamamoto Nakamura Kobayashi Sato Kumar Sharma Gupta Mehta Reddy Iyer Nair
  `)
);

/** Titles before a name. Matched with or without a trailing dot. */
export const NAME_TITLES: ReadonlySet<string> = new Set(
  words("Mr Mrs Ms Miss Mx Dr Prof Professor Sir Dame Lady Lord Rev Reverend Fr Capt Captain Col Sgt Judge Hon Herr Frau Mme Mlle Monsieur Madame Señor Señora Sr Sra")
);

/** Field labels a name follows (`Name:`, `Patient:`), compared in lower case. Multi-word labels end in their last word. */
export const NAME_LABELS: readonly string[] = [
  "name",
  "full name",
  "first name",
  "last name",
  "given name",
  "surname",
  "family name",
  "patient",
  "patient name",
  "customer",
  "customer name",
  "client",
  "client name",
  "employee",
  "employee name",
  "contact",
  "contact name",
  "applicant",
  "recipient",
  "sender",
  "attn",
  "attention",
  "signed",
  "signature",
  "cardholder",
  "card holder",
  "account holder",
  "account name",
  "insured",
  "member",
  "member name",
  "guest",
  "guest name",
  "passenger",
  "tenant",
  "landlord",
  "owner",
  "beneficiary",
  "next of kin",
  "emergency contact",
  "physician",
  "doctor",
  "student",
  "candidate",
  "author",
  "assignee",
  "reporter",
  "requester",
  "requested by",
  "approved by",
  "prepared by",
  "signed by"
];

export const SALUTATIONS: ReadonlySet<string> = new Set(words("Dear Hi Hello Hey Greetings Howdy"));

/** Sign-offs, lower case; the name is on the next line. */
export const SIGN_OFFS: readonly string[] = [
  "regards",
  "best regards",
  "kind regards",
  "warm regards",
  "warmest regards",
  "best wishes",
  "all the best",
  "sincerely",
  "yours sincerely",
  "sincerely yours",
  "yours truly",
  "yours faithfully",
  "thanks",
  "thank you",
  "many thanks",
  "cheers",
  "best",
  "respectfully",
  "cordially"
];

/** Phrases a name follows (lower case): `my name is Ana Diaz`. */
export const NAME_PHRASES: readonly string[] = ["my name is", "name is", "named", "called", "signed by", "written by", "authored by", "assigned to", "on behalf of", "speak to", "spoke with", "spoke to", "contact"];

/**
 * Capitalised words that are not names (sentence starts, months, days, greetings' objects, common nouns written in
 * title case), so `Dear Customer` or `Hello World` is never a name.
 */
export const NOT_NAME_WORDS: ReadonlySet<string> = new Set(
  words(`
  The A An This That These Those It Its Is Are Was Were Be I We You He She They Me Us Them My Our Your His Her Their
  And Or But If Then So As At By For From In Into Of On To With Without About After Before Not No Yes Ok Okay
  Re Fwd Fw Subject Cc Bcc Date Time Note Notes Team All Everyone Folks Guys Sir Madam Madame Customer Customers
  Client Colleague Colleagues Friend Friends Member Members User Users Admin Support Sales Service Services Hiring
  Manager Committee Board World There Here Hello Hi Hey Dear Thanks Thank Regards Best Cheers Sincerely Yours
  Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April June July August September
  October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Today Tomorrow Yesterday
  Mr Mrs Ms Dr Prof Inc Ltd LLC Corp Company Co Group Department Dept Office Street Road Avenue Lane Drive
  Unknown None Null Undefined True False Name Patient Test Example Sample Demo New Old Main Home Page Report Order
  Invoice Account Number Total Please Kind Warm Many Yours Truly Faithfully Respectfully Cordially Signature
  `)
);

/** Name particles written in lower case inside a name (`Ludwig van Beethoven`). */
export const NAME_PARTICLES: ReadonlySet<string> = new Set(words("van von de da del della der den di du la le bin binti al el ter"));

// Places

export const COUNTRIES: readonly string[] = `
  Afghanistan|Albania|Algeria|Andorra|Angola|Argentina|Armenia|Australia|Austria|Azerbaijan|Bahamas|Bahrain|Bangladesh|
  Barbados|Belarus|Belgium|Belize|Benin|Bhutan|Bolivia|Bosnia and Herzegovina|Botswana|Brazil|Brunei|Bulgaria|
  Burkina Faso|Burundi|Cambodia|Cameroon|Canada|Chad|Chile|China|Colombia|Comoros|Congo|Costa Rica|Croatia|Cuba|
  Cyprus|Czechia|Czech Republic|Denmark|Djibouti|Dominica|Dominican Republic|Ecuador|Egypt|El Salvador|Eritrea|
  Estonia|Eswatini|Ethiopia|Fiji|Finland|France|Gabon|Gambia|Georgia|Germany|Ghana|Greece|Grenada|Guatemala|Guinea|
  Guyana|Haiti|Honduras|Hungary|Iceland|India|Indonesia|Iran|Iraq|Ireland|Israel|Italy|Jamaica|Japan|Jordan|
  Kazakhstan|Kenya|Kiribati|Kosovo|Kuwait|Kyrgyzstan|Laos|Latvia|Lebanon|Lesotho|Liberia|Libya|Liechtenstein|
  Lithuania|Luxembourg|Madagascar|Malawi|Malaysia|Maldives|Mali|Malta|Mauritania|Mauritius|Mexico|Moldova|Monaco|
  Mongolia|Montenegro|Morocco|Mozambique|Myanmar|Namibia|Nepal|Netherlands|New Zealand|Nicaragua|Niger|Nigeria|
  North Korea|North Macedonia|Norway|Oman|Pakistan|Palestine|Panama|Papua New Guinea|Paraguay|Peru|Philippines|
  Poland|Portugal|Qatar|Romania|Russia|Rwanda|Samoa|San Marino|Saudi Arabia|Senegal|Serbia|Seychelles|Sierra Leone|
  Singapore|Slovakia|Slovenia|Somalia|South Africa|South Korea|South Sudan|Spain|Sri Lanka|Sudan|Suriname|Sweden|
  Switzerland|Syria|Taiwan|Tajikistan|Tanzania|Thailand|Togo|Tonga|Trinidad and Tobago|Tunisia|Turkey|Türkiye|
  Turkmenistan|Tuvalu|Uganda|Ukraine|United Arab Emirates|United Kingdom|United States|United States of America|
  Uruguay|Uzbekistan|Vanuatu|Vatican City|Venezuela|Vietnam|Yemen|Zambia|Zimbabwe|England|Scotland|Wales|
  Northern Ireland|Great Britain|Puerto Rico|Hong Kong|Greenland`
  .split("|")
  .map((entry) => entry.trim())
  .filter(Boolean);

export const US_STATES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia", PR: "Puerto Rico"
};

export const CA_PROVINCES: ReadonlySet<string> = new Set(words("AB BC MB NB NL NS NT NU ON PE QC SK YT"));
export const AU_STATES: ReadonlySet<string> = new Set(words("NSW VIC QLD SA WA TAS NT ACT"));

export const CITIES: readonly string[] = `
  New York|Los Angeles|Chicago|Houston|Phoenix|Philadelphia|San Antonio|San Diego|Dallas|San Jose|Austin|
  Jacksonville|San Francisco|Columbus|Seattle|Denver|Boston|Nashville|Detroit|Portland|Las Vegas|Memphis|Baltimore|
  Milwaukee|Albuquerque|Atlanta|Miami|Minneapolis|New Orleans|Cleveland|Pittsburgh|Cincinnati|St. Louis|Salt Lake City|
  Sacramento|Orlando|Tampa|Honolulu|Anchorage|Springfield|Toronto|Montreal|Vancouver|Calgary|Ottawa|Edmonton|
  Winnipeg|Quebec City|Halifax|London|Manchester|Birmingham|Liverpool|Leeds|Glasgow|Edinburgh|Bristol|Cardiff|
  Belfast|Oxford|Cambridge|Dublin|Paris|Lyon|Marseille|Toulouse|Nice|Bordeaux|Lille|Strasbourg|Nantes|Berlin|Hamburg|
  Munich|München|Cologne|Köln|Frankfurt|Stuttgart|Düsseldorf|Leipzig|Dresden|Hanover|Nuremberg|Bremen|Vienna|Zurich|
  Geneva|Basel|Bern|Amsterdam|Rotterdam|The Hague|Brussels|Antwerp|Copenhagen|Stockholm|Oslo|Helsinki|Madrid|
  Barcelona|Valencia|Seville|Lisbon|Porto|Rome|Milan|Naples|Turin|Florence|Venice|Athens|Warsaw|Krakow|Prague|
  Budapest|Bucharest|Sofia|Istanbul|Ankara|Moscow|Kyiv|Kiev|Cairo|Lagos|Nairobi|Johannesburg|Cape Town|Casablanca|
  Dubai|Abu Dhabi|Doha|Riyadh|Tel Aviv|Jerusalem|Mumbai|Delhi|New Delhi|Bangalore|Bengaluru|Chennai|Kolkata|
  Hyderabad|Karachi|Lahore|Dhaka|Bangkok|Singapore|Kuala Lumpur|Jakarta|Manila|Hanoi|Ho Chi Minh City|Beijing|
  Shanghai|Shenzhen|Guangzhou|Hong Kong|Taipei|Seoul|Tokyo|Osaka|Kyoto|Sydney|Melbourne|Brisbane|Perth|Adelaide|
  Canberra|Hobart|Darwin|Auckland|Wellington|Christchurch|Mexico City|Guadalajara|Bogotá|Bogota|Lima|Santiago|
  Buenos Aires|São Paulo|Sao Paulo|Rio de Janeiro|Brasília|Caracas|Havana`
  .split("|")
  .map((entry) => entry.trim())
  .filter(Boolean);

/**
 * Place names that are also common names or words (`Jordan`, `Georgia`, `Turkey`, `Nice`): reported only after a
 * strong place cue (`in`, `from`, `based in`), never after `to` or `at`, and never on their own.
 */
export const AMBIGUOUS_PLACES: ReadonlySet<string> = new Set(
  words(`
  Jordan Georgia Chad Victoria Florence Paris Austin Sydney Phoenix Washington Lincoln Charlotte Madison Dallas
  Houston Orlando Mobile Turkey China Nice Reading Bath Chester Jersey Israel Kent Darwin Perth Wellington Columbus
  Springfield Portland Cambridge Oxford Hanover Santiago Lima Sofia Guinea Niger Mali Cuba Peru Oman Monaco Malta
  Chile Denver Dakota Carolina Virginia Indiana Montana Nevada Florida Maine Georgia Bristol Valencia Porto Darwin
  `)
);

/** Phrases a place follows. Strong cues accept a capitalised word that is not in the lists. */
export const STRONG_PLACE_PHRASES: readonly string[] = ["lives in", "living in", "lived in", "born in", "based in", "located in", "resides in", "residing in", "moved to", "relocated to", "grew up in", "headquartered in", "travelling to", "traveling to", "flew to", "visiting"];
export const PLACE_PREPOSITIONS: ReadonlySet<string> = new Set(words("in from near across throughout outside inside around within"));
/** Weak prepositions: a listed, unambiguous place only. */
export const WEAK_PLACE_PREPOSITIONS: ReadonlySet<string> = new Set(words("to at via into"));

/** Field labels a place follows (lower case). */
export const PLACE_LABELS: readonly string[] = ["city", "town", "country", "location", "state", "province", "region", "county", "place of birth", "birthplace", "hometown", "destination", "origin", "residence", "home town"];

// Street addresses

/** English street types (US, UK, CA, AU), compared case-sensitively in title case or upper case. */
export const STREET_TYPES: ReadonlySet<string> = new Set(
  words(`
  Street St Avenue Ave Av Road Rd Boulevard Blvd Lane Ln Drive Dr Court Ct Place Pl Way Terrace Ter Tce Circle Cir
  Parkway Pkwy Highway Hwy Square Sq Trail Trl Close Cl Crescent Cres Gardens Gdns Grove Gr Mews Row Hill Walk
  Parade Pde Esplanade Esp Alley Plaza Crossing Xing Loop Path Pike Run Expressway Expy Freeway Fwy Broadway Green
  Wharf Quay Rise Vale View Heights Hts Point Pt
  `)
);

/** Unit designators after a street line (`Apt 4B`, `Suite 200`, `#12`). */
export const UNIT_WORDS: ReadonlySet<string> = new Set(words("Apt Apartment Suite Ste Unit Flat Fl Floor Room Rm Bldg Building Dept"));

export const DIRECTIONS: ReadonlySet<string> = new Set(words("N S E W NE NW SE SW North South East West"));

/** German street words: as the end of a compound (`Hauptstraße`) or a word of their own (`Berliner Straße`). */
export const DE_STREET_SUFFIXES: readonly string[] = ["straße", "strasse", "str", "weg", "platz", "allee", "gasse", "damm", "ufer", "chaussee", "steig", "pfad"];

/** French street types, compared in lower case. */
export const FR_STREET_TYPES: ReadonlySet<string> = new Set(words("rue avenue av boulevard bd place allée allee impasse chemin quai route cours square passage voie"));
export const FR_PARTICLES: ReadonlySet<string> = new Set(words("de du des la le les l d' l' d au aux sur"));
